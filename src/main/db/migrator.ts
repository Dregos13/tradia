import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

/**
 * Ejecutor de migraciones versionadas.
 *
 * Cada migración es `{ version, name, up, down }` (SQL). Las versiones
 * aplicadas se registran en `schema_migrations` junto al checksum SHA-256
 * del `up`, así un cambio en un archivo ya aplicado se detecta al arrancar.
 * Cada migración corre en una transacción y tiene `down` para revertir
 * sin pérdida fuera de lo que la propia migración crea.
 */
export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

export function appliedMigrations(db: Database.Database): AppliedMigration[] {
  ensureMigrationsTable(db);
  return db
    .prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')
    .all() as AppliedMigration[];
}

function validate(migrations: readonly Migration[]): void {
  const seen = new Set<number>();
  let previous = 0;
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= 0) {
      throw new MigrationError(`migración con versión inválida: ${m.version}`);
    }
    if (seen.has(m.version)) {
      throw new MigrationError(`versión de migración duplicada: ${m.version}`);
    }
    if (m.version <= previous) {
      throw new MigrationError(`las migraciones deben ir ordenadas por versión (${m.version})`);
    }
    if (!m.up.trim()) {
      throw new MigrationError(`la migración ${m.version} (${m.name}) no tiene bloque up`);
    }
    seen.add(m.version);
    previous = m.version;
  }
}

/** Aplica las migraciones pendientes en orden. Devuelve las versiones aplicadas. */
export function migrate(db: Database.Database, migrations: readonly Migration[]): number[] {
  validate(migrations);
  ensureMigrationsTable(db);

  const applied = new Map(appliedMigrations(db).map((row) => [row.version, row]));
  const appliedNow: number[] = [];

  for (const migration of migrations) {
    const existing = applied.get(migration.version);
    if (existing) {
      if (existing.checksum !== checksum(migration.up)) {
        throw new MigrationError(
          `la migración ${migration.version} (${migration.name}) ya está aplicada y su contenido ha cambiado`,
        );
      }
      continue;
    }
    db.transaction(() => {
      db.exec(migration.up);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(migration.version, migration.name, checksum(migration.up), new Date().toISOString());
    })();
    appliedNow.push(migration.version);
  }

  return appliedNow;
}

/** Revierte la última migración aplicada ejecutando su `down`. Devuelve su versión o null. */
export function rollbackLast(
  db: Database.Database,
  migrations: readonly Migration[],
): number | null {
  validate(migrations);
  ensureMigrationsTable(db);

  const applied = appliedMigrations(db);
  const last = applied[applied.length - 1];
  if (!last) return null;

  const migration = migrations.find((m) => m.version === last.version);
  if (!migration) {
    throw new MigrationError(
      `la migración ${last.version} (${last.name}) está aplicada pero no existe su archivo`,
    );
  }
  if (last.checksum !== checksum(migration.up)) {
    throw new MigrationError(
      `la migración ${last.version} (${last.name}) ha cambiado desde que se aplicó`,
    );
  }

  db.transaction(() => {
    db.exec(migration.down);
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(migration.version);
  })();

  return migration.version;
}
