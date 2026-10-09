import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Migraciones previas a la biblioteca de estrategias. */
const PHASE_0_1B = MIGRATIONS.filter((m) => m.version <= 4);
/** Hasta estrategias inclusive: lo que cubre esta prueba (vendrán más). */
const PHASE_2 = MIGRATIONS.filter((m) => m.version <= 5);

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

const INSERT_STRATEGY = "INSERT INTO strategies (estado) VALUES ('investigacion')";
const INSERT_VERSION = `INSERT INTO strategy_versions (
    strategy_id, version, nombre, hipotesis,
    regla_entrada, regla_salida, regla_stop, regla_objetivo,
    parametros, mercados, regimen, costes, nota
  ) VALUES (
    1, 1, 'Cruce 50/200', 'La tendencia persiste',
    'compra al cruzar al alza', 'vende al cruzar a la baja', 'stop 2 ATR', 'sin objetivo',
    '{"fast":50,"slow":200}', '["SPY"]', 'tendencial',
    '{"commissionPct":0.05,"commissionMin":1,"slippageBps":5,"spreadBps":2}', 'Alta'
  )`;

describe('migración 005 · estrategias', () => {
  it('sube sobre una base de la fase 1b sin perder datos existentes', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_1B);

    db.prepare(
      "INSERT INTO watchlist (ticker, alta, orden) VALUES ('SPY', '2026-10-09T00:00:00Z', 0)",
    ).run();
    db.prepare(
      "INSERT INTO news_sources (nombre, tipo, conector, url, fiabilidad) VALUES ('Reuters', 'rss', 'rss', 'https://feeds.test/rss', 'agencia')",
    ).run();

    // Solo la migración 005 queda pendiente.
    expect(migrate(db, PHASE_2)).toEqual([5]);

    expect((db.prepare('SELECT COUNT(*) AS n FROM watchlist').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM news_sources').get() as { n: number }).n).toBe(1);
    expect(tableNames(db)).toEqual(
      expect.arrayContaining(['strategies', 'strategy_versions', 'strategy_changelog']),
    );
    db.close();
  });

  it('exige el catálogo de estados y arranca en investigacion', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_2);

    // El estado por defecto del alta es 'investigacion'.
    db.prepare('INSERT INTO strategies DEFAULT VALUES').run();
    expect(
      (db.prepare('SELECT estado AS e FROM strategies WHERE id = 1').get() as { e: string }).e,
    ).toBe('investigacion');

    // Estados fuera del catálogo quedan rechazados, también en el registro.
    expect(() =>
      db.prepare("INSERT INTO strategies (estado) VALUES ('en-vivo')").run(),
    ).toThrowError();
    db.prepare(INSERT_STRATEGY).run();
    db.prepare(INSERT_VERSION).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO strategy_changelog (strategy_id, tipo, estado_anterior, estado_nuevo, nota) VALUES (1, 'estado', 'investigacion', 'en-vivo', 'x')",
        )
        .run(),
    ).toThrowError();
    db.close();
  });

  it('versiona por (strategy_id, version) y conserva las versiones anteriores', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_2);
    db.prepare(INSERT_STRATEGY).run();
    db.prepare(INSERT_VERSION).run();

    // La misma versión no se puede repetir para una estrategia…
    expect(() => db.prepare(INSERT_VERSION).run()).toThrowError();
    // …pero la siguiente sí, y la 1 sigue intacta.
    db.prepare(INSERT_VERSION.replace('1, 1,', '1, 2,').replace("'Alta'", "'v2'")).run();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM strategy_versions').get() as { n: number }).n,
    ).toBe(2);

    // Version 0 o negativa no cabe.
    expect(() => db.prepare(INSERT_VERSION.replace('1, 1,', '1, 0,')).run()).toThrowError();
    db.close();
  });

  it('el registro exige coherencia: versión solo en altas y extremos en estados', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_2);
    db.prepare(INSERT_STRATEGY).run();
    db.prepare(INSERT_VERSION).run();

    // Una entrada de tipo 'version' sin número de versión queda rechazada…
    expect(() =>
      db
        .prepare(
          "INSERT INTO strategy_changelog (strategy_id, tipo, version, nota) VALUES (1, 'version', NULL, 'x')",
        )
        .run(),
    ).toThrowError();
    // …y una de 'estado' con versión, también.
    expect(() =>
      db
        .prepare(
          "INSERT INTO strategy_changelog (strategy_id, tipo, version, estado_anterior, estado_nuevo, nota) VALUES (1, 'estado', 2, 'investigacion', 'paper', 'x')",
        )
        .run(),
    ).toThrowError();
    // Un cambio de estado necesita los dos extremos.
    expect(() =>
      db
        .prepare(
          "INSERT INTO strategy_changelog (strategy_id, tipo, estado_anterior, nota) VALUES (1, 'estado', 'investigacion', 'x')",
        )
        .run(),
    ).toThrowError();

    // Entradas coherentes sí pasan.
    db.prepare(
      "INSERT INTO strategy_changelog (strategy_id, tipo, version, nota) VALUES (1, 'version', 1, 'Alta')",
    ).run();
    db.prepare(
      "INSERT INTO strategy_changelog (strategy_id, tipo, estado_anterior, estado_nuevo, nota) VALUES (1, 'estado', 'investigacion', 'paper', 'Pasa a paper')",
    ).run();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM strategy_changelog').get() as { n: number }).n,
    ).toBe(2);
    db.close();
  });

  it('los periodos van completos y ordenados', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_2);
    db.prepare(INSERT_STRATEGY).run();

    const insertWithPeriod = (desde: string | null, hasta: string | null) =>
      db
        .prepare(
          `INSERT INTO strategy_versions (
            strategy_id, version, nombre, hipotesis,
            regla_entrada, regla_salida, regla_stop, regla_objetivo,
            parametros, mercados, regimen, costes, nota,
            entrenamiento_desde, entrenamiento_hasta
          ) VALUES (
            1, 1, 'a', 'b', 'e', 's', 'st', 't', '{}', '[]', 'r', '{}', 'n', ?, ?
          )`,
        )
        .run(desde, hasta);

    // Periodo cojo (solo un extremo) o con 'desde' posterior a 'hasta'.
    expect(() => insertWithPeriod('2010-01-01', null)).toThrowError();
    expect(() => insertWithPeriod(null, '2015-01-01')).toThrowError();
    expect(() => insertWithPeriod('2020-01-01', '2019-01-01')).toThrowError();
    expect(() => insertWithPeriod('2010-01-01', '2015-12-31')).not.toThrowError();
    db.close();
  });

  it('cascada: borrar una estrategia elimina sus versiones y su registro', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, PHASE_2);
    db.prepare(INSERT_STRATEGY).run();
    db.prepare(INSERT_VERSION).run();
    db.prepare(
      "INSERT INTO strategy_changelog (strategy_id, tipo, version, nota) VALUES (1, 'version', 1, 'Alta')",
    ).run();

    db.prepare('DELETE FROM strategies WHERE id = 1').run();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM strategy_versions').get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM strategy_changelog').get() as { n: number }).n,
    ).toBe(0);
    db.close();
  });

  it('revertir la 005 solo elimina las tablas de estrategias', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_2);
    db.prepare(INSERT_STRATEGY).run();

    expect(rollbackLast(db, PHASE_2)).toBe(5);
    const tables = tableNames(db);
    expect(tables).not.toContain('strategies');
    expect(tables).not.toContain('strategy_versions');
    expect(tables).not.toContain('strategy_changelog');
    // Las fases anteriores quedan intactas.
    expect(tables).toContain('watchlist');
    expect(tables).toContain('news_sources');
    db.close();
  });
});
