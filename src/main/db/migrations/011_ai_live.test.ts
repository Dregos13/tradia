import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Migraciones previas: lo que la 011 necesita (fichas, backtests, noticias). */
const PHASE_0_5 = MIGRATIONS.filter((m) => m.version <= 10);
/** Hasta la IA predictiva y el dinero real inclusive: lo que cubre esta prueba. */
const PHASE_6_7 = MIGRATIONS.filter((m) => m.version <= 11);

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

/** Ficha de estrategia mínima en la base de la fase 5; devuelve su id. */
function insertStrategy(db: Database.Database, name: string): number {
  const id = Number(
    db.prepare("INSERT INTO strategies (estado) VALUES ('activa')").run().lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO strategy_versions
       (strategy_id, version, nombre, hipotesis, regla_entrada, regla_salida,
        regla_stop, regla_objetivo, parametros, rangos_parametros, mercados,
        regimen, costes, nota)
     VALUES (?, 1, ?, 'hipótesis', 'entra', 'sale', 'stop', 'objetivo',
             '{}', '{}', '["SPY"]', 'régimen en texto', '{}', 'alta')`,
  ).run(id, name);
  return id;
}

/** Ejecución de backtest mínima ligada a la versión de la estrategia. */
function insertBacktestRun(db: Database.Database, strategyId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO backtest_runs
           (strategy_id, version, kind, config, costes, metricas, curva,
            operaciones, fuente, proveedor)
         VALUES (?, 1, 'completo', '{}', '{}', '{}', '[]', '[]', 'simulated', 'sim')`,
      )
      .run(strategyId).lastInsertRowid,
  );
}

/** Titular previo (fase 1b) para probar el enlace del análisis. */
function insertNewsItem(db: Database.Database): number {
  return Number(
    db
      .prepare(
        `INSERT INTO news_items (titulo, publicado, prioridad, confirmada, hash)
         VALUES ('Titular previo', '2026-10-08T12:00:00.000Z', 'media', 1, 'h-1')`,
      )
      .run().lastInsertRowid,
  );
}

describe('migración 011 · IA predictiva y dinero real', () => {
  it('sube sobre la fase anterior y crea las tablas y columnas nuevas', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_5);

    expect(migrate(db, PHASE_6_7)).toEqual([11]);
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'regime_comparisons',
        'regimes',
        'model_cards',
        'predictions',
        'news_analysis',
        'drift_checks',
        'retrain_proposals',
        'live_checklist',
        'live_limits',
        'live_mode',
      ]),
    );
    expect(columnNames(db, 'strategy_versions')).toEqual(
      expect.arrayContaining(['regimen_funciona_en', 'regimen_falla_en']),
    );
    expect(columnNames(db, 'backtest_runs')).toEqual(expect.arrayContaining(['regimen_filtro']));
    db.close();
  });

  it('aplica limpia sobre una base vacía', () => {
    const db = new Database(':memory:');
    expect(migrate(db, PHASE_6_7)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    db.close();
  });

  it('rellena el régimen estructurado de las cuatro semillas por nombre', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_5);
    // Fichas ya existentes de la fase 5 (se crearon antes de la 011).
    insertStrategy(db, 'Cruce de medias');
    insertStrategy(db, 'Reversión RSI/Bollinger');
    insertStrategy(db, 'Ruptura de rangos');
    insertStrategy(db, 'Momentum entre activos');
    insertStrategy(db, 'Estrategia del usuario');

    migrate(db, PHASE_6_7);
    const rows = db
      .prepare(
        `SELECT nombre, regimen_funciona_en AS works, regimen_falla_en AS fails
         FROM strategy_versions ORDER BY strategy_id`,
      )
      .all() as { nombre: string; works: string; fails: string }[];
    expect(rows.map((r) => [r.nombre, r.works, r.fails])).toEqual([
      ['Cruce de medias', '["tendencia"]', '[]'],
      ['Reversión RSI/Bollinger', '["lateral"]', '["tendencia"]'],
      ['Ruptura de rangos', '["tendencia"]', '[]'],
      ['Momentum entre activos', '["tendencia"]', '[]'],
      // Las fichas ajenas a las semillas quedan sin preferencia declarada.
      ['Estrategia del usuario', '[]', '[]'],
    ]);
    db.close();
  });

  it('los CHECK de régimen rechazan valores ajenos a los dos ejes', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_6_7);
    const insert = db.prepare(
      `INSERT INTO regimes (ambito, ticker, sesion, eje_direccion, eje_volatilidad)
       VALUES ('activo', 'AAPL', '2026-10-09', ?, ?)`,
    );
    insert.run('tendencia', 'volatilidad-alta');
    expect(() => insert.run('alza', 'volatilidad-alta')).toThrowError();
    expect(() => insert.run('tendencia', 'alta')).toThrowError();
    // La misma etiqueta repetida para activo y sesión choca con el UNIQUE.
    expect(() =>
      db
        .prepare(
          `INSERT INTO regimes (ambito, ticker, sesion, eje_direccion, eje_volatilidad)
           VALUES ('activo', 'AAPL', '2026-10-09', 'lateral', 'volatilidad-baja')`,
        )
        .run(),
    ).toThrowError();
    // El mercado usa su propio ámbito sobre la referencia.
    db.prepare(
      `INSERT INTO regimes (ambito, ticker, sesion, eje_direccion, eje_volatilidad)
       VALUES ('mercado', 'SPY', '2026-10-09', 'tendencia', 'volatilidad-baja')`,
    ).run();
    db.close();
  });

  it('predicciones: probabilidad acotada y una por activo/sesión/modelo', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_6_7);
    const insert = db.prepare(
      `INSERT INTO predictions
         (ticker, sesion, horizonte_dias, prob_subida, vol_esperada,
          modelo_version, modelo_hash)
       VALUES ('AAPL', '2026-10-09', 5, ?, 0.03, '0.1.0', 'abc')`,
    );
    insert.run(0.62);
    expect(() => insert.run(1.2)).toThrowError();
    expect(() => insert.run(-0.1)).toThrowError();
    // Mismo activo y sesión con la misma versión de modelo no se repite.
    expect(() => insert.run(0.4)).toThrowError();
    db.prepare(
      `INSERT INTO predictions
         (ticker, sesion, horizonte_dias, prob_subida, modelo_version, modelo_hash)
       VALUES ('AAPL', '2026-10-09', 5, 0.4, '0.2.0', 'def')`,
    ).run();
    db.close();
  });

  it('análisis de noticias: un sentimiento por activo y titular, ligado a news_items', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, PHASE_6_7);
    const newsId = insertNewsItem(db);
    const insert = db.prepare(
      `INSERT INTO news_analysis (noticia_id, ticker, resumen, sentimiento, analizador)
       VALUES (?, ?, 'resumen', ?, ?)`,
    );
    insert.run(newsId, 'AAPL', 'positivo', 'local');
    // Otro activo para el mismo titular sí entra; el mismo no (UNIQUE).
    insert.run(newsId, 'MSFT', 'negativo', 'llm');
    expect(() => insert.run(newsId, 'MSFT', 'positivo', 'local')).toThrowError();
    // Sentimiento o analizador ajenos al contrato quedan rechazados.
    expect(() => insert.run(newsId, 'NVDA', 'inventado', 'local')).toThrowError();
    expect(() => insert.run(newsId, 'NVDA', 'positivo', 'humano')).toThrowError();
    // El borrado del titular arrastra su análisis.
    db.prepare('DELETE FROM news_items WHERE id = ?').run(newsId);
    expect((db.prepare('SELECT COUNT(*) AS n FROM news_analysis').get() as { n: number }).n).toBe(
      0,
    );
    db.close();
  });

  it('drift y reentrenamiento: literales acotados y una propuesta por trimestre', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_6_7);
    const check = db.prepare(
      `INSERT INTO drift_checks (ambito, sujeto_nombre, tipo, evaluado_en, resultado)
       VALUES (?, 'sujeto', ?, '2026-10-09T22:00:00.000Z', ?)`,
    );
    check.run('modelo', 'datos', 'alerta');
    expect(() => check.run('usuario', 'datos', 'ok')).toThrowError();
    expect(() => check.run('modelo', 'precios', 'ok')).toThrowError();
    expect(() => check.run('modelo', 'datos', 'grave')).toThrowError();

    const proposal = db.prepare(
      `INSERT INTO retrain_proposals (trimestre, motivo) VALUES (?, 'drift')`,
    );
    proposal.run('2026-Q4');
    // La regla de «como mucho una por trimestre natural» la impone el UNIQUE.
    expect(() => proposal.run('2026-Q4')).toThrowError();
    proposal.run('2027-Q1');
    // Estado ajeno a pendiente/aprobada/pospuesta queda rechazado.
    expect(() =>
      db
        .prepare(`UPDATE retrain_proposals SET estado = 'en-curso' WHERE trimestre = '2026-Q4'`)
        .run(),
    ).toThrowError();
    db.close();
  });

  it('la lista de dinero real nace con los siete requisitos pendientes', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_6_7);
    const rows = db
      .prepare('SELECT requisito, estado FROM live_checklist ORDER BY rowid')
      .all() as { requisito: string; estado: string }[];
    expect(rows.map((r) => r.requisito)).toEqual([
      'validacion-fuera-muestra',
      'paper-continuo',
      'parada-probada',
      'alertas-activas',
      'claves-sin-retirada',
      'plan-contingencia',
      'revision-legal',
    ]);
    expect(rows.every((r) => r.estado === 'pendiente')).toBe(true);
    // Un requisito ajeno a la lista no puede aparecer.
    expect(() =>
      db.prepare(`INSERT INTO live_checklist (requisito) VALUES ('inventado')`).run(),
    ).toThrowError();
    // El modo arranca bloqueado en su fila única.
    const mode = db.prepare('SELECT id, estado FROM live_mode').get() as {
      id: number;
      estado: string;
    };
    expect(mode).toEqual({ id: 1, estado: 'bloqueado' });
    db.close();
  });

  it('los límites escritos no pueden superar los techos fijos de la fase', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_6_7);
    const insert = db.prepare(
      `INSERT INTO live_limits (capital_usd, orden_usd, perdida_diaria_usd, posiciones_max)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run(500, 100, 10, 1);
    // Fila única: no cabe una segunda configuración.
    expect(() => insert.run(400, 90, 9, 2)).toThrowError();
    db.prepare('DELETE FROM live_limits').run();
    expect(() => insert.run(1_001, 100, 10, 1)).toThrowError();
    expect(() => insert.run(500, 201, 10, 1)).toThrowError();
    expect(() => insert.run(500, 100, 21, 1)).toThrowError();
    expect(() => insert.run(500, 100, 10, 3)).toThrowError();
    expect(() => insert.run(0, 100, 10, 1)).toThrowError();
    db.close();
  });

  it('la comparación de régimen se liga a la versión y es única por ella', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, PHASE_6_7);
    const id = insertStrategy(db, 'Cruce de medias');
    const runId = insertBacktestRun(db, id);
    db.prepare(
      `INSERT INTO regime_comparisons (strategy_id, version, run_sin_filtro, run_con_filtro)
       VALUES (?, 1, ?, ?)`,
    ).run(id, runId, runId);
    // Una comparación por versión: la segunda para la misma se rechaza.
    expect(() =>
      db.prepare(`INSERT INTO regime_comparisons (strategy_id, version) VALUES (?, 1)`).run(id),
    ).toThrowError();
    // El run nuevo queda marcado como «sin filtro» por defecto.
    const run = db
      .prepare('SELECT regimen_filtro AS f FROM backtest_runs WHERE id = ?')
      .get(runId) as { f: number };
    expect(run.f).toBe(0);
    db.close();
  });

  it('revertir la 011 solo retira lo suyo y conserva los datos de fases previas', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, PHASE_6_7);
    const strategyId = insertStrategy(db, 'Cruce de medias');
    insertBacktestRun(db, strategyId);
    insertNewsItem(db);
    db.prepare(
      `INSERT INTO regimes (ambito, ticker, sesion, eje_direccion, eje_volatilidad)
       VALUES ('activo', 'AAPL', '2026-10-09', 'tendencia', 'volatilidad-alta')`,
    ).run();

    expect(rollbackLast(db, PHASE_6_7)).toBe(11);
    const names = tableNames(db);
    for (const table of [
      'regime_comparisons',
      'regimes',
      'model_cards',
      'predictions',
      'news_analysis',
      'drift_checks',
      'retrain_proposals',
      'live_checklist',
      'live_limits',
      'live_mode',
    ]) {
      expect(names).not.toContain(table);
    }
    expect(columnNames(db, 'strategy_versions')).not.toContain('regimen_funciona_en');
    expect(columnNames(db, 'backtest_runs')).not.toContain('regimen_filtro');
    // Los datos de las fases anteriores sobreviven a la reversión.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM strategy_versions').get() as { n: number }).n,
    ).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM news_items').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM backtest_runs').get() as { n: number }).n).toBe(
      1,
    );
    db.close();
  });
});
