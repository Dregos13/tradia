import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { MIGRATIONS } from './migrations';
import { migrate, type Migration } from './migrator';

/**
 * Abre (o crea) la base de datos SQLite y aplica las migraciones pendientes.
 * WAL para lecturas concurrentes y claves foráneas activas por defecto.
 */
export function openDatabase(
  file: string,
  migrations: readonly Migration[] = MIGRATIONS,
): Database.Database {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db, migrations);
  return db;
}
