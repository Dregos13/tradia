import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './migrations';
import { appliedMigrations, migrate, MigrationError, rollbackLast } from './migrator';

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe('ejecutor de migraciones', () => {
  it('aplica todas las migraciones desde cero y registra schema_migrations', () => {
    const db = new Database(':memory:');
    const applied = migrate(db, MIGRATIONS);

    expect(applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(appliedMigrations(db).map((m) => m.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
    db.close();
  });

  it('es idempotente: una segunda ejecución no aplica nada', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS);

    expect(migrate(db, MIGRATIONS)).toEqual([]);
    expect(appliedMigrations(db)).toHaveLength(17);
    db.close();
  });

  it('crea las tablas de dominio, de estado de la app y de datos de mercado', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS);

    expect(tableNames(db)).toEqual([
      'backtest_runs',
      'bars',
      'broker_orders',
      'broker_orders_live',
      'calendar_events',
      'corporate_actions',
      'data_batches',
      'data_status',
      'deviation_alerts',
      'diario',
      'drift_checks',
      'journal_entries',
      'kill_switch_events',
      'live_checklist',
      'live_limits',
      'live_mode',
      'macro_observations',
      'macro_series',
      'model_cards',
      'news_analysis',
      'news_item_assets',
      'news_item_sources',
      'news_items',
      'news_sources',
      'noticias',
      'notification_log',
      'predictions',
      'quality_flags',
      'reconcile_discrepancies',
      'reconcile_runs',
      'regime_comparisons',
      'regimes',
      'retrain_proposals',
      'risk_equity_history',
      'risk_limits',
      'risk_portfolio_positions',
      'risk_vetoes',
      'routine_runs',
      'schema_migrations',
      'secrets',
      'senales',
      'series',
      'settings',
      'signals',
      'strategies',
      'strategy_changelog',
      'strategy_implementations',
      'strategy_versions',
      'stress_results',
      'watchlist',
    ]);
    db.close();
  });

  it('impone las restricciones del esquema (hash único en noticias)', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS);
    const insert = db.prepare(
      "INSERT INTO noticias (fuente, url, titulo, publicado, hash) VALUES ('rss', ?, 't', '2026-01-01', 'h1')",
    );
    insert.run('https://ejemplo.test/a');
    expect(() => insert.run('https://ejemplo.test/b')).toThrowError();
    db.close();
  });

  it('revierte la última migración con su bloque down', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS);

    expect(rollbackLast(db, MIGRATIONS)).toBe(17);
    const cuentaCol = db.prepare("SELECT name FROM pragma_table_info('reconcile_runs')").all() as {
      name: string;
    }[];
    expect(cuentaCol.map((c) => c.name)).not.toContain('cuenta');
    expect(() =>
      db.prepare(`INSERT INTO live_checklist (requisito) VALUES ('paper-cortos')`).run(),
    ).toThrowError();

    expect(rollbackLast(db, MIGRATIONS)).toBe(16);
    const columnas = db.prepare("SELECT name FROM pragma_table_info('live_limits')").all() as {
      name: string;
    }[];
    expect(columnas.map((c) => c.name)).not.toContain('corto_orden_usd');

    expect(rollbackLast(db, MIGRATIONS)).toBe(15);
    expect(tableNames(db)).toContain('journal_entries');
    expect(tableNames(db)).toContain('news_analysis');

    expect(rollbackLast(db, MIGRATIONS)).toBe(14);
    expect(tableNames(db)).toContain('journal_entries');
    expect(tableNames(db)).toContain('news_analysis');

    expect(rollbackLast(db, MIGRATIONS)).toBe(13);
    expect(tableNames(db)).toContain('news_analysis');
    expect(tableNames(db)).toContain('journal_entries');

    expect(rollbackLast(db, MIGRATIONS)).toBe(12);
    expect(tableNames(db)).not.toContain('broker_orders_live');
    expect(tableNames(db)).toContain('live_mode');
    expect(tableNames(db)).toContain('broker_orders');

    expect(rollbackLast(db, MIGRATIONS)).toBe(11);
    expect(tableNames(db)).not.toContain('regimes');
    expect(tableNames(db)).not.toContain('live_mode');
    expect(tableNames(db)).toContain('broker_orders');

    expect(rollbackLast(db, MIGRATIONS)).toBe(10);
    expect(tableNames(db)).not.toContain('broker_orders');
    expect(tableNames(db)).toContain('journal_entries');

    expect(rollbackLast(db, MIGRATIONS)).toBe(9);
    expect(tableNames(db)).toContain('journal_entries');
    expect(tableNames(db)).toContain('risk_vetoes');

    expect(rollbackLast(db, MIGRATIONS)).toBe(8);
    expect(tableNames(db)).not.toContain('journal_entries');
    expect(tableNames(db)).toContain('risk_vetoes');

    expect(rollbackLast(db, MIGRATIONS)).toBe(7);
    expect(tableNames(db)).not.toContain('risk_vetoes');
    expect(tableNames(db)).toContain('backtest_runs');

    expect(rollbackLast(db, MIGRATIONS)).toBe(6);
    expect(tableNames(db)).not.toContain('backtest_runs');
    expect(tableNames(db)).toContain('strategies');

    expect(rollbackLast(db, MIGRATIONS)).toBe(5);
    expect(tableNames(db)).not.toContain('strategies');
    expect(tableNames(db)).toContain('news_items');

    expect(rollbackLast(db, MIGRATIONS)).toBe(4);
    expect(tableNames(db)).not.toContain('news_items');
    expect(tableNames(db)).toContain('bars');

    expect(rollbackLast(db, MIGRATIONS)).toBe(3);
    expect(tableNames(db)).not.toContain('bars');
    expect(tableNames(db)).toContain('series');

    expect(rollbackLast(db, MIGRATIONS)).toBe(2);
    expect(tableNames(db)).not.toContain('secrets');
    expect(tableNames(db)).toContain('series');

    expect(rollbackLast(db, MIGRATIONS)).toBe(1);
    expect(tableNames(db)).toEqual(['schema_migrations']);
    expect(rollbackLast(db, MIGRATIONS)).toBeNull();
    db.close();
  });

  it('permite remigrar tras revertir', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS);
    rollbackLast(db, MIGRATIONS);

    expect(migrate(db, MIGRATIONS)).toEqual([17]);
    expect(tableNames(db)).toContain('broker_orders_live');
    expect(tableNames(db)).toContain('regimes');
    expect(tableNames(db)).toContain('live_mode');
    expect(tableNames(db)).toContain('watchlist');
    db.close();
  });

  it('la migración 016 deja el corto a 0 sin tocar los límites del largo ya confirmados', () => {
    const db = new Database(':memory:');
    // Esquema hasta la 015: live_limits con las cuatro columnas del largo.
    migrate(db, MIGRATIONS.slice(0, 15));
    db.prepare(
      `INSERT INTO live_limits
         (id, capital_usd, orden_usd, perdida_diaria_usd, posiciones_max,
          confirmados, guardados_en, confirmados_en)
       VALUES (1, 500, 100, 10, 1, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z')`,
    ).run();

    expect(migrate(db, MIGRATIONS)).toEqual([16, 17]);

    const row = db.prepare('SELECT * FROM live_limits WHERE id = 1').get() as Record<
      string,
      number | string | null
    >;
    // El largo queda intacto y sigue confirmado; el corto arranca a 0
    // (desactivado hasta que el usuario lo confirme por escrito).
    expect(row['capital_usd']).toBe(500);
    expect(row['orden_usd']).toBe(100);
    expect(row['perdida_diaria_usd']).toBe(10);
    expect(row['posiciones_max']).toBe(1);
    expect(row['confirmados']).toBe(1);
    expect(row['confirmados_en']).toBe('2026-10-01T00:01:00.000Z');
    expect(row['corto_orden_usd']).toBe(0);
    expect(row['corto_exposicion_usd']).toBe(0);
    expect(row['corto_posiciones_max']).toBe(0);

    // Los CHECK del corto acotan igual que los del largo.
    expect(() =>
      db.prepare('UPDATE live_limits SET corto_exposicion_usd = 201 WHERE id = 1').run(),
    ).toThrowError();
    expect(() =>
      db.prepare('UPDATE live_limits SET corto_posiciones_max = 2 WHERE id = 1').run(),
    ).toThrowError();
    expect(() =>
      db.prepare('UPDATE live_limits SET corto_orden_usd = -1 WHERE id = 1').run(),
    ).toThrowError();
    db.close();
  });

  it('detecta si un archivo de migración ya aplicada cambia (checksum)', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS);

    const tampered = MIGRATIONS.map((m) =>
      m.version === 1 ? { ...m, up: `${m.up}\n-- cambio` } : m,
    );
    expect(() => migrate(db, tampered)).toThrowError(MigrationError);
    db.close();
  });

  it('rechaza listas de migraciones con versiones duplicadas', () => {
    const db = new Database(':memory:');
    const dup = [MIGRATIONS[0]!, { ...MIGRATIONS[0]!, name: 'copia' }];
    expect(() => migrate(db, dup)).toThrowError(MigrationError);
    db.close();
  });
});
