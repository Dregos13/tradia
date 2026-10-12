import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Migraciones previas: todo lo que la 015 necesita (estrategias). */
const PHASE_0_14 = MIGRATIONS.filter((m) => m.version <= 14);
/** Hasta las reglas de corto de la ficha inclusive: lo que cubre esta prueba. */
const ALL = MIGRATIONS.filter((m) => m.version <= 15);

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

/** Alta mínima de una versión de ficha; devuelve su strategy_id. */
const insertVersion = (
  db: Database.Database,
  entryShort: string | null,
  exitShort: string | null,
): number => {
  db.prepare('INSERT INTO strategies DEFAULT VALUES').run();
  db.prepare(
    `INSERT INTO strategy_versions (
       strategy_id, version, nombre, hipotesis,
       regla_entrada, regla_salida, regla_stop, regla_objetivo,
       regla_entrada_corto, regla_salida_corto,
       regimen, costes, nota
     ) VALUES (1, 1, 'n', 'h', 'e', 'x', 's', 't', ?, ?, 'r', '{}', 'n')`,
  ).run(entryShort, exitShort);
  return 1;
};

describe('migración 015 · reglas de corto de la ficha', () => {
  it('sube sobre la fase anterior y añade las columnas sin tocar filas', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_14);
    expect(columnNames(db, 'strategy_versions')).not.toContain('regla_entrada_corto');
    expect(columnNames(db, 'strategy_versions')).not.toContain('regla_salida_corto');
    db.prepare('INSERT INTO strategies DEFAULT VALUES').run();
    db.prepare(
      `INSERT INTO strategy_versions (
         strategy_id, version, nombre, hipotesis,
         regla_entrada, regla_salida, regla_stop, regla_objetivo,
         regimen, costes, nota
       ) VALUES (1, 1, 'n', 'h', 'e', 'x', 's', 't', 'r', '{}', 'n')`,
    ).run();

    expect(migrate(db, ALL)).toEqual([15]);
    expect(columnNames(db, 'strategy_versions')).toContain('regla_entrada_corto');
    expect(columnNames(db, 'strategy_versions')).toContain('regla_salida_corto');
    // La versión guardada antes de subir queda intacta: sin corto (NULL).
    const row = db
      .prepare(
        'SELECT regla_entrada_corto, regla_salida_corto FROM strategy_versions WHERE strategy_id = 1',
      )
      .get() as { regla_entrada_corto: string | null; regla_salida_corto: string | null };
    expect(row).toEqual({ regla_entrada_corto: null, regla_salida_corto: null });
    db.close();
  });

  it('exige la pareja completa y texto no vacío', () => {
    const db = new Database(':memory:');
    migrate(db, ALL);
    expect(insertVersion(db, 'cruza_abajo(sma(3), sma(8))', 'cruza_arriba(sma(3), sma(8))')).toBe(
      1,
    );
    // Sin corto: NULL en ambas vale.
    db.prepare('INSERT INTO strategies DEFAULT VALUES').run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO strategy_versions (
             strategy_id, version, nombre, hipotesis,
             regla_entrada, regla_salida, regla_stop, regla_objetivo,
             regimen, costes, nota
           ) VALUES (2, 1, 'n', 'h', 'e', 'x', 's', 't', 'r', '{}', 'n')`,
        )
        .run(),
    ).not.toThrow();
    // Solo una de las dos no vale; en blanco tampoco.
    expect(() => insertVersion(db, 'cierre < sma(20)', null)).toThrowError();
    expect(() => insertVersion(db, null, 'cierre > sma(20)')).toThrowError();
    expect(() => insertVersion(db, '   ', 'cierre > sma(20)')).toThrowError();
    db.close();
  });

  it('el down retira las columnas y conserva las versiones', () => {
    const db = new Database(':memory:');
    migrate(db, ALL);
    insertVersion(db, 'cruza_abajo(sma(3), sma(8))', 'cruza_arriba(sma(3), sma(8))');

    expect(rollbackLast(db, ALL)).toBe(15);
    expect(columnNames(db, 'strategy_versions')).not.toContain('regla_entrada_corto');
    expect(columnNames(db, 'strategy_versions')).not.toContain('regla_salida_corto');
    const count = db.prepare('SELECT COUNT(*) AS n FROM strategy_versions').get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it('aplica limpia sobre una base vacía', () => {
    const db = new Database(':memory:');
    expect(migrate(db, ALL)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    db.close();
  });
});
