import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Migraciones previas (incluye estrategias): lo que la 006 extiende. */
const PHASE_0_2 = MIGRATIONS.filter((m) => m.version <= 5);
/** Hasta backtests inclusive: lo que cubre esta prueba (vendrán más). */
const PHASE_2_BT = MIGRATIONS.filter((m) => m.version <= 6);

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

const SEED_STRATEGY = `
  INSERT INTO strategies DEFAULT VALUES;
  INSERT INTO strategy_versions (
    strategy_id, version, nombre, hipotesis,
    regla_entrada, regla_salida, regla_stop, regla_objetivo,
    parametros, mercados, regimen, costes, nota
  ) VALUES (
    1, 1, 'Cruce 50/200', 'La tendencia persiste',
    'compra al cruzar al alza', 'vende al cruzar a la baja', 'stop 2 ATR', 'sin objetivo',
    '{"fast":50,"slow":200}', '["SPY"]', 'tendencial',
    '{"commissionPct":0.05,"commissionMin":1,"slippageBps":5,"spreadBps":2}', 'Alta'
  )
`;

const INSERT_RUN = `INSERT INTO backtest_runs (
    strategy_id, version, kind, config, costes, metricas, curva, operaciones,
    avisos, fuente, proveedor
  ) VALUES (1, 1, ?, '{}', '{}', '{}', '[]', '[]', '[]', 'simulated', 'simulated')`;

describe('migración 006 · backtests y estrés', () => {
  it('sube sobre una base con estrategias sin perder datos existentes', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_2);
    db.exec(SEED_STRATEGY);

    expect(migrate(db, PHASE_2_BT)).toEqual([6]);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM strategy_versions').get() as { n: number }).n,
    ).toBe(1);
    expect(tableNames(db)).toEqual(
      expect.arrayContaining(['backtest_runs', 'stress_results', 'strategy_implementations']),
    );
    db.close();
  });

  it('liga cada run a una versión existente de la estrategia', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, PHASE_2_BT);
    db.exec(SEED_STRATEGY);

    db.prepare(INSERT_RUN).run('completo');
    // Una versión inexistente queda rechazada por la clave foránea.
    expect(() =>
      db
        .prepare(INSERT_RUN.replace('1, 1,', '1, 9,'))
        .run('completo'),
    ).toThrowError();
    db.close();
  });

  it('el bloqueo de la prueba final admite una sola ejecución por versión', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_2_BT);
    db.exec(SEED_STRATEGY);

    db.prepare(INSERT_RUN).run('completo');
    db.prepare(INSERT_RUN).run('prueba-final');
    // La segunda prueba final de la misma versión se rechaza…
    expect(() => db.prepare(INSERT_RUN).run('prueba-final')).toThrowError();
    // …pero otra versión sí puede ejecutar la suya.
    db.exec(
      `INSERT INTO strategy_versions (
        strategy_id, version, nombre, hipotesis,
        regla_entrada, regla_salida, regla_stop, regla_objetivo,
        parametros, mercados, regimen, costes, nota
      ) VALUES (
        1, 2, 'Cruce 50/200', 'La tendencia persiste',
        'e', 's', 'st', 't', '{}', '["SPY"]', 'tendencial', '{}', 'v2'
      )`,
    );
    db.prepare(INSERT_RUN.replace('1, 1,', '1, 2,')).run('prueba-final');
    // completo v1 + prueba-final v1 + prueba-final v2 (la v1 repetida se rechazó).
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM backtest_runs').get() as { n: number }).n,
    ).toBe(3);
    db.close();
  });

  it('una crisis por versión: repetir la prueba la sobrescribe', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_2_BT);
    db.exec(SEED_STRATEGY);

    const insertStress = db.prepare(
      `INSERT INTO stress_results
         (strategy_id, version, crisis, crisis_nombre, desde, hasta, sesiones,
          rentabilidad, drawdown, operaciones, benchmark, benchmark_rentabilidad,
          fuente, proveedor, curva)
       VALUES (1, 1, '2008', 'Crisis financiera 2008', '2007-10-09', '2009-03-09',
               340, -0.12, 0.31, 4, 'SPY', -0.42, 'simulated', 'simulated', '[]')`,
    );
    insertStress.run();
    // La misma crisis para la misma versión colisiona (el servicio hace UPSERT).
    expect(() => insertStress.run()).toThrowError();
    // Otra crisis u otra versión sí caben.
    db.prepare(
      `INSERT INTO stress_results
         (strategy_id, version, crisis, crisis_nombre, desde, hasta, sesiones,
          benchmark, fuente, proveedor)
       VALUES (1, 1, '2020', 'Choque del covid 2020', '2020-02-19', '2020-06-30',
               90, 'SPY', 'simulated', 'simulated')`,
    ).run();
    db.close();
  });

  it('cascada: borrar la estrategia elimina runs, estrés e implementación', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, PHASE_2_BT);
    db.exec(SEED_STRATEGY);
    db.prepare(
      "INSERT INTO strategy_implementations (strategy_id, impl_key) VALUES (1, 'sma-cross')",
    ).run();
    db.prepare(INSERT_RUN).run('completo');
    db.prepare(
      `INSERT INTO stress_results
         (strategy_id, version, crisis, crisis_nombre, desde, hasta, sesiones,
          benchmark, fuente, proveedor)
       VALUES (1, 1, '2008', 'Crisis financiera 2008', '2007-10-09', '2009-03-09',
               340, 'SPY', 'simulated', 'simulated')`,
    ).run();

    db.prepare('DELETE FROM strategies WHERE id = 1').run();
    for (const table of ['backtest_runs', 'stress_results', 'strategy_implementations']) {
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      ).toBe(0);
    }
    db.close();
  });

  it('revertir la 006 solo elimina las tablas de backtest', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_2_BT);
    db.exec(SEED_STRATEGY);

    expect(rollbackLast(db, PHASE_2_BT)).toBe(6);
    const tables = tableNames(db);
    expect(tables).not.toContain('backtest_runs');
    expect(tables).not.toContain('stress_results');
    expect(tables).not.toContain('strategy_implementations');
    // Las fases anteriores quedan intactas.
    expect(tables).toContain('strategies');
    expect(tables).toContain('strategy_versions');
    db.close();
  });
});
