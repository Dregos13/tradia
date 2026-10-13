import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Migraciones previas: todo lo que la 017 necesita (live + conciliación). */
const PHASE_0_16 = MIGRATIONS.filter((m) => m.version <= 16);
/** Hasta los requisitos del corto inclusive: lo que cubre esta prueba. */
const ALL = MIGRATIONS.filter((m) => m.version <= 17);

const requirements = (db: Database.Database): string[] =>
  (
    db.prepare('SELECT requisito FROM live_checklist ORDER BY requisito').all() as {
      requisito: string;
    }[]
  ).map((row) => row.requisito);

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

describe('migración 017 · requisitos propios del corto', () => {
  it('amplía el CHECK de live_checklist y conserva las filas existentes', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_16);
    // Antes de subir, los requisitos del corto no caben en el CHECK.
    expect(requirements(db)).toHaveLength(7);
    expect(() =>
      db.prepare(`INSERT INTO live_checklist (requisito) VALUES ('revision-legal-corto')`).run(),
    ).toThrowError();
    // Una declaración suscrita antes de la migración debe sobrevivir.
    db.prepare(
      `UPDATE live_checklist
         SET estado = 'cumplido', declaracion = 'He revisado con profesionales mis obligaciones legales y fiscales.',
             marcado_en = '2026-10-01T10:00:00.000Z'
       WHERE requisito = 'revision-legal'`,
    ).run();

    expect(migrate(db, ALL)).toEqual([17]);

    const names = requirements(db);
    expect(names).toHaveLength(9);
    expect(names).toContain('revision-legal-corto');
    expect(names).toContain('paper-cortos');
    // Las nuevas nacen pendientes, sin evidencia ni declaración.
    const paperCortos = db
      .prepare(
        `SELECT estado, evidencia, declaracion FROM live_checklist WHERE requisito = 'paper-cortos'`,
      )
      .get() as { estado: string; evidencia: string | null; declaracion: string | null };
    expect(paperCortos).toEqual({ estado: 'pendiente', evidencia: null, declaracion: null });
    // La declaración ya suscrita queda intacta.
    const legal = db
      .prepare(
        `SELECT estado, declaracion, marcado_en FROM live_checklist WHERE requisito = 'revision-legal'`,
      )
      .get() as { estado: string; declaracion: string | null; marcado_en: string | null };
    expect(legal.estado).toBe('cumplido');
    expect(legal.declaracion).toContain('obligaciones legales y fiscales');
    expect(legal.marcado_en).toBe('2026-10-01T10:00:00.000Z');
    db.close();
  });

  it('añade cuenta a reconcile_runs con paper por defecto', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_16);
    // Una pasada anterior a la migración migra como 'paper' (conservador).
    db.prepare(
      `INSERT INTO reconcile_runs (origen, iniciada_en) VALUES ('manual', '2026-10-01')`,
    ).run();

    expect(migrate(db, ALL)).toEqual([17]);
    expect(columnNames(db, 'reconcile_runs')).toContain('cuenta');
    const old = db.prepare('SELECT cuenta FROM reconcile_runs ORDER BY id').get() as {
      cuenta: string;
    };
    expect(old.cuenta).toBe('paper');
    // Las nuevas pasadas llevan su cuenta y el CHECK la acota.
    db.prepare(
      `INSERT INTO reconcile_runs (origen, iniciada_en, cuenta) VALUES ('manual', '2026-10-02', 'live')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO reconcile_runs (origen, iniciada_en, cuenta) VALUES ('manual', '2026-10-03', 'otra')`,
        )
        .run(),
    ).toThrowError();
    db.close();
  });

  it('el down devuelve la lista a los siete y retira cuenta sin tocar el resto', () => {
    const db = new Database(':memory:');
    migrate(db, ALL);
    db.prepare(
      `UPDATE live_checklist
         SET estado = 'cumplido', declaracion = 'texto', marcado_en = '2026-10-01T10:00:00.000Z'
       WHERE requisito = 'revision-legal-corto'`,
    ).run();
    db.prepare(
      `INSERT INTO reconcile_runs (origen, iniciada_en, cuenta) VALUES ('manual', '2026-10-02', 'live')`,
    ).run();

    expect(rollbackLast(db, ALL)).toBe(17);
    expect(requirements(db)).toHaveLength(7);
    expect(requirements(db)).not.toContain('paper-cortos');
    expect(columnNames(db, 'reconcile_runs')).not.toContain('cuenta');
    // La pasada y los siete requisitos del largo sobreviven al down.
    const runs = db.prepare('SELECT COUNT(*) AS n FROM reconcile_runs').get() as { n: number };
    expect(runs.n).toBe(1);
    // Y el CHECK vuelve a rechazar los requisitos del corto.
    expect(() =>
      db.prepare(`INSERT INTO live_checklist (requisito) VALUES ('paper-cortos')`).run(),
    ).toThrowError();
    db.close();
  });

  it('aplica limpia sobre una base vacía', () => {
    const db = new Database(':memory:');
    expect(migrate(db, ALL)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    db.close();
  });
});
