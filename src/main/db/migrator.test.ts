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

    expect(applied).toEqual([1, 2, 3, 4, 5]);
    expect(appliedMigrations(db).map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
    db.close();
  });

  it('es idempotente: una segunda ejecución no aplica nada', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS);

    expect(migrate(db, MIGRATIONS)).toEqual([]);
    expect(appliedMigrations(db)).toHaveLength(5);
    db.close();
  });

  it('crea las tablas de dominio, de estado de la app y de datos de mercado', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS);

    expect(tableNames(db)).toEqual([
      'bars',
      'calendar_events',
      'corporate_actions',
      'data_batches',
      'data_status',
      'diario',
      'macro_observations',
      'macro_series',
      'news_item_assets',
      'news_item_sources',
      'news_items',
      'news_sources',
      'noticias',
      'notification_log',
      'quality_flags',
      'schema_migrations',
      'secrets',
      'senales',
      'series',
      'settings',
      'strategies',
      'strategy_changelog',
      'strategy_versions',
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

    expect(migrate(db, MIGRATIONS)).toEqual([5]);
    expect(tableNames(db)).toContain('watchlist');
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
