import type { ServiceContext } from './index';

/**
 * Almacén local (SQLite) — stub.
 *
 * La tarea «storage-db» lo implementa: better-sqlite3 en
 * `app.getPath('userData')/tradia.db` con migraciones versionadas en
 * `src/main/db/migrations` (series, noticias, señales, diario).
 */
export interface StorageService {
  /** true cuando la base de datos está abierta y migrada. */
  readonly ready: boolean;
  init(): Promise<void>;
  close(): void;
}

export function registerStorage(_ctx: ServiceContext): StorageService {
  return {
    ready: false,
    init() {
      // TODO(storage-db): abrir la base de datos y ejecutar las migraciones.
      return Promise.resolve();
    },
    close() {
      // TODO(storage-db): cerrar la base de datos.
    },
  };
}
