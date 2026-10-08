import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { app } from 'electron';

import { openDatabase } from '../db/database';
import type { Migration } from '../db/migrator';
import type { ServiceContext } from './index';

/**
 * Almacén local: SQLite (better-sqlite3) en `app.getPath('userData')/tradia.db`.
 * Abre la base de datos y aplica las migraciones de `src/main/db/migrations`
 * al registrarse. Si la apertura falla, `ready` queda en false y los servicios
 * que dependen del almacén degradan en lugar de romper el arranque.
 */
export const DB_FILENAME = 'tradia.db';

export interface StorageOptions {
  /** Ruta del archivo de base de datos; ':memory:' en pruebas. */
  dbFile?: string;
  /** Lista de migraciones; por defecto las registradas en db/migrations. */
  migrations?: Migration[];
}

export interface StorageService {
  /** true cuando la base de datos está abierta y migrada. */
  readonly ready: boolean;
  /** Ruta del archivo en disco (o ':memory:'). */
  readonly dbPath: string;
  /** Instancia abierta, o null si la inicialización falló. */
  getDb(): Database.Database | null;
  /** Idempotente: abre la base de datos si aún no está abierta. */
  init(): Promise<void>;
  close(): void;
}

export function registerStorage(
  _ctx: ServiceContext,
  options: StorageOptions = {},
): StorageService {
  const dbPath = options.dbFile ?? join(app.getPath('userData'), DB_FILENAME);
  let db: Database.Database | null = null;

  const open = (): void => {
    if (db) return;
    try {
      db = openDatabase(dbPath, options.migrations);
    } catch (error: unknown) {
      // Sin datos personales: solo la ruta y el error de sistema.
      console.error(`[storage] no se pudo abrir la base de datos en ${dbPath}`, error);
    }
  };

  // better-sqlite3 es síncrono: la apertura y las migraciones ocurren aquí.
  open();

  return {
    get ready() {
      return db !== null;
    },
    dbPath,
    getDb: () => db,
    init: () => {
      open();
      return Promise.resolve();
    },
    close: () => {
      db?.close();
      db = null;
    },
  };
}
