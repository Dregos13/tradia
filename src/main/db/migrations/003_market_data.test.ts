import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Migraciones de la fase 0-1, antes de los datos de mercado. */
const PHASE_0_1 = MIGRATIONS.filter((m) => m.version <= 2);
/** Hasta noticias inclusive: lo que cubre esta prueba. */
const PHASE_1B = MIGRATIONS.filter((m) => m.version <= 4);

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe('migración 003 · datos de mercado', () => {
  it('sube sobre una base de la fase 0-1 sin perder datos existentes', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_1);

    db.prepare(
      "INSERT INTO series (ticker, fecha, open, high, low, close, volume, fuente) VALUES ('AAPL', '2026-10-07', 1, 2, 0.5, 1.5, 100, 'yahoo')",
    ).run();
    db.prepare(
      "INSERT INTO noticias (fuente, url, titulo, publicado, hash) VALUES ('rss', 'https://ejemplo.test/n', 't', '2026-10-07', 'h1')",
    ).run();
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('autostart', 'true', '2026-10-07T00:00:00Z')",
    ).run();

    // Solo las migraciones 003 y 004 quedan pendientes en esta prueba.
    expect(migrate(db, PHASE_1B)).toEqual([3, 4]);

    expect((db.prepare('SELECT COUNT(*) AS n FROM series').get() as { n: number }).n).toBe(1);
    expect(
      (db.prepare('SELECT titulo AS t FROM noticias WHERE hash = ?').get('h1') as { t: string }).t,
    ).toBe('t');
    expect(
      (db.prepare("SELECT value AS v FROM settings WHERE key = 'autostart'").get() as { v: string })
        .v,
    ).toBe('true');

    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'watchlist',
        'bars',
        'corporate_actions',
        'data_batches',
        'quality_flags',
        'macro_series',
        'macro_observations',
        'data_status',
      ]),
    );
    db.close();
  });

  it('impone la unicidad de bars por ticker, fecha y fuente', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS);
    db.prepare(
      "INSERT INTO data_batches (version, hash, proveedor, ambito, ticker, desde, hasta, recibido_en) VALUES (1, 'h', 'tiingo', 'bars', 'AAPL', '2026-10-07', '2026-10-07', '2026-10-08T00:00:00Z')",
    ).run();
    const insert = db.prepare(
      "INSERT INTO bars (ticker, fecha, fuente, lote_id, open, high, low, close, volume) VALUES ('AAPL', '2026-10-07', 'tiingo', 1, 1, 2, 0.5, 1.5, 100)",
    );
    insert.run();
    expect(() => insert.run()).toThrowError();
    // La misma sesión desde otra fuente sí cabe.
    db.prepare(
      "INSERT INTO bars (ticker, fecha, fuente, lote_id, open, high, low, close, volume) VALUES ('AAPL', '2026-10-07', 'otra', 1, 1, 2, 0.5, 1.5, 100)",
    ).run();
    db.close();
  });

  it('exige la coherencia del ámbito del lote y los estados de salud válidos', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS);

    // Un lote 'bars' sin ticker no pasa el CHECK.
    expect(() =>
      db
        .prepare(
          "INSERT INTO data_batches (version, hash, proveedor, ambito, desde, hasta, recibido_en) VALUES (1, 'h', 'tiingo', 'bars', '2026-10-07', '2026-10-07', '2026-10-08T00:00:00Z')",
        )
        .run(),
    ).toThrowError();

    // Estados fuera del catálogo quedan rechazados.
    expect(() =>
      db
        .prepare(
          "INSERT INTO data_status (clave, estado, actualizado_en) VALUES ('ticker:AAPL', 'caido', '2026-10-08T00:00:00Z')",
        )
        .run(),
    ).toThrowError();
    db.prepare(
      "INSERT INTO data_status (clave, estado, ultimo_ok, fallos_seguidos, motivo, actualizado_en) VALUES ('provider:tiingo', 'no-fiable', '2026-10-07T00:00:00Z', 3, 'HTTP 503', '2026-10-08T00:00:00Z')",
    ).run();
    db.close();
  });

  it('cascada: borrar un lote elimina sus velas y marcas de calidad', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    db.prepare(
      "INSERT INTO data_batches (version, hash, proveedor, ambito, ticker, desde, hasta, recibido_en) VALUES (1, 'h', 'tiingo', 'bars', 'AAPL', '2026-10-07', '2026-10-07', '2026-10-08T00:00:00Z')",
    ).run();
    db.prepare(
      "INSERT INTO bars (ticker, fecha, fuente, lote_id, open, high, low, close, volume) VALUES ('AAPL', '2026-10-07', 'tiingo', 1, 1, 2, 0.5, 1.5, 100)",
    ).run();
    db.prepare(
      "INSERT INTO quality_flags (lote_id, ticker, fecha, tipo, detalle) VALUES (1, 'AAPL', '2026-10-07', 'anomalo', 'salto >8σ')",
    ).run();

    db.prepare('DELETE FROM data_batches WHERE id = 1').run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM bars').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM quality_flags').get() as { n: number }).n).toBe(
      0,
    );
    db.close();
  });

  it('revertir la 003 solo elimina las tablas de mercado', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_1B);
    db.prepare(
      "INSERT INTO watchlist (ticker, alta, orden) VALUES ('SPY', '2026-10-08T00:00:00Z', 0)",
    ).run();

    // Primero cae la 004 (noticias) y luego la 003 (mercado).
    expect(rollbackLast(db, MIGRATIONS)).toBe(4);
    expect(rollbackLast(db, MIGRATIONS)).toBe(3);
    expect(tableNames(db)).not.toContain('watchlist');
    expect(tableNames(db)).toContain('series');
    db.close();
  });
});
