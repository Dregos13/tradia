import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Migraciones previas: todo lo que la 014 necesita (diario y noticias). */
const PHASE_0_12 = MIGRATIONS.filter((m) => m.version <= 12);
/** Hasta el modo por entrada del diario inclusive: lo que cubre esta prueba. */
const ALL = MIGRATIONS.filter((m) => m.version <= 14);

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

const insertEntry = (db: Database.Database, modo: string | null): number => {
  const stmt =
    modo === null
      ? db.prepare(`INSERT INTO journal_entries (tipo, motivo) VALUES ('resumen', 'r')`)
      : db.prepare(
          `INSERT INTO journal_entries (tipo, modo, motivo) VALUES ('operacion', ?, 'r')`,
        );
  return Number(stmt.run(...(modo === null ? [] : [modo])).lastInsertRowid);
};

describe('migración 014 · modo por entrada del diario', () => {
  it('sube sobre la fase anterior y añade journal_entries.modo sin tocar filas', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_12);
    expect(columnNames(db, 'journal_entries')).not.toContain('modo');
    const id = Number(
      db.prepare(`INSERT INTO journal_entries (tipo, motivo) VALUES ('operacion', 'r')`).run()
        .lastInsertRowid,
    );
    // Datos de la 012 y de las tablas que la 013 recrea: una orden real
    // y un análisis de noticia ya guardados antes de subir.
    db.prepare(
      `INSERT INTO broker_orders_live
         (client_order_id, ticker, tipo, lado, cantidad, pedida_en)
       VALUES ('tradia-humo-1-compra', 'SPY', 'limit', 'buy', 0.002, '2026-10-08T20:00:00.000Z')`,
    ).run();
    const newsId = Number(
      db
        .prepare(
          `INSERT INTO news_items (titulo, url, publicado, resumen, prioridad, confirmada, hash)
           VALUES ('Titular', NULL, '2026-10-10T10:00:00.000Z', NULL, 'activo', 1, 'h1')`,
        )
        .run().lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO news_analysis (noticia_id, ticker, resumen, sentimiento, analizador)
       VALUES (?, 'AAPL', 'resumen', 'positivo', 'local')`,
    ).run(newsId);

    // La 013 (CHECK del analizador) también sube en esta pasada.
    expect(migrate(db, ALL)).toEqual([13, 14]);
    expect(columnNames(db, 'journal_entries')).toContain('modo');
    const row = db.prepare('SELECT tipo, modo FROM journal_entries WHERE id = ?').get(id) as {
      tipo: string;
      modo: string | null;
    };
    // La fila previa no se pierde y queda sin cuenta, como le corresponde.
    expect(row).toEqual({ tipo: 'operacion', modo: null });
    // Ni la orden real (012) ni el análisis copiado por la 013 se pierden.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM broker_orders_live').get() as { n: number },
    ).toEqual({ n: 1 });
    expect(
      db
        .prepare('SELECT ticker, analizador FROM news_analysis WHERE noticia_id = ?')
        .get(newsId) as { ticker: string; analizador: string },
    ).toEqual({ ticker: 'AAPL', analizador: 'local' });
    db.close();
  });

  it('aplica limpia sobre una base vacía', () => {
    const db = new Database(':memory:');
    expect(migrate(db, ALL)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    db.close();
  });

  it('admite paper y live y rechaza cualquier otro modo', () => {
    const db = new Database(':memory:');
    migrate(db, ALL);
    expect(insertEntry(db, 'paper')).toBeGreaterThan(0);
    expect(insertEntry(db, 'live')).toBeGreaterThan(0);
    expect(insertEntry(db, null)).toBeGreaterThan(0);
    expect(() =>
      db
        .prepare(`INSERT INTO journal_entries (tipo, modo, motivo) VALUES ('operacion', 'x', 'r')`)
        .run(),
    ).toThrowError();
    db.close();
  });

  it('el down retira la columna y conserva todas las entradas', () => {
    const db = new Database(':memory:');
    migrate(db, ALL);
    insertEntry(db, 'live');
    insertEntry(db, null);

    expect(rollbackLast(db, ALL)).toBe(14);
    expect(columnNames(db, 'journal_entries')).not.toContain('modo');
    const count = db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number };
    expect(count.n).toBe(2);
    // La 013 sigue aplicada: 'suscripcion' en el analizador no se toca.
    expect(
      columnNames(db, 'news_analysis').length > 0 &&
        db.prepare("SELECT COUNT(*) AS n FROM news_analysis").get(),
    ).toBeTruthy();
    db.close();
  });
});
