import type Database from 'better-sqlite3';
import { ipcMain, safeStorage } from 'electron';

import { IPC_CHANNELS, IpcValidationError, isNonEmptyString } from '../../shared/ipc';
import type { ServiceContext } from './index';

/**
 * Claves de API cifradas con el llavero del sistema operativo.
 *
 * `safeStorage.encryptString` cifra y el resultado se guarda en base64 en la
 * tabla `secrets`. Si el cifrado no está disponible (p. ej. Linux sin
 * llavero), la operación falla con un error claro: nunca se guarda texto
 * plano. El renderer puede escribir, comprobar y borrar claves, pero NO
 * leerlas: `getKey` solo existe para uso interno del proceso principal.
 */

/** Subconjunto de safeStorage de Electron, inyectable en pruebas. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /**
   * Backend de llavero elegido por Electron (solo existe en Linux). El valor
   * 'basic_text' usa una clave fija y equivale a texto plano: se rechaza.
   */
  getSelectedStorageBackend?(): string;
}

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsError';
  }
}

export const ERR_ENCRYPTION_UNAVAILABLE =
  'El cifrado del sistema no está disponible (safeStorage): no se guardan claves en texto plano. ' +
  'En Linux instala un llavero como gnome-keyring o kwallet.';
export const ERR_STORAGE_UNAVAILABLE =
  'El almacén local no está disponible: no se pueden gestionar claves.';

export interface SecretsService {
  setKey(provider: string, apiKey: string): Promise<void>;
  hasKey(provider: string): Promise<boolean>;
  deleteKey(provider: string): Promise<void>;
  /** Solo uso interno del proceso principal; nunca se expone por IPC. */
  getKey(provider: string): Promise<string | null>;
}

export function createSecretsService(
  db: Database.Database | null,
  crypto: SafeStorageLike,
): SecretsService {
  const requireDb = (): Database.Database => {
    if (!db) throw new SecretsError(ERR_STORAGE_UNAVAILABLE);
    return db;
  };

  const requireRealEncryption = (): void => {
    if (!crypto.isEncryptionAvailable()) {
      throw new SecretsError(ERR_ENCRYPTION_UNAVAILABLE);
    }
    // En Linux sin llavero Electron usa el backend 'basic_text' (clave fija,
    // en la práctica texto plano) y aun así isEncryptionAvailable() puede
    // devolver true. 'basic_text' solo se reporta en Linux.
    if (crypto.getSelectedStorageBackend?.() === 'basic_text') {
      throw new SecretsError(ERR_ENCRYPTION_UNAVAILABLE);
    }
  };

  return {
    setKey: async (provider, apiKey) => {
      const database = requireDb();
      requireRealEncryption();
      const ciphertext = crypto.encryptString(apiKey).toString('base64');
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO secrets (provider, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (provider)
           DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
        )
        .run(provider, ciphertext, now, now);
    },
    hasKey: async (provider) => {
      const database = requireDb();
      const row = database
        .prepare('SELECT 1 AS found FROM secrets WHERE provider = ?')
        .get(provider) as { found: number } | undefined;
      return row !== undefined;
    },
    deleteKey: async (provider) => {
      const database = requireDb();
      database.prepare('DELETE FROM secrets WHERE provider = ?').run(provider);
    },
    getKey: async (provider) => {
      const database = requireDb();
      const row = database
        .prepare('SELECT ciphertext FROM secrets WHERE provider = ?')
        .get(provider) as { ciphertext: string } | undefined;
      if (!row) return null;
      requireRealEncryption();
      try {
        return crypto.decryptString(Buffer.from(row.ciphertext, 'base64'));
      } catch {
        throw new SecretsError(
          `no se pudo descifrar la clave de '${provider}': el cifrado del sistema cambió o el dato está corrupto`,
        );
      }
    },
  };
}

export function registerSecrets(ctx: ServiceContext): SecretsService {
  const service = createSecretsService(ctx.services.storage?.getDb() ?? null, safeStorage);

  ipcMain.handle(IPC_CHANNELS.secrets.setKey, (_event, provider: unknown, apiKey: unknown) => {
    if (!isNonEmptyString(provider) || !isNonEmptyString(apiKey)) {
      throw new IpcValidationError(IPC_CHANNELS.secrets.setKey, 'provider y apiKey requeridos');
    }
    return service.setKey(provider, apiKey);
  });
  ipcMain.handle(IPC_CHANNELS.secrets.hasKey, (_event, provider: unknown) => {
    if (!isNonEmptyString(provider)) {
      throw new IpcValidationError(IPC_CHANNELS.secrets.hasKey, 'provider requerido');
    }
    return service.hasKey(provider);
  });
  ipcMain.handle(IPC_CHANNELS.secrets.deleteKey, (_event, provider: unknown) => {
    if (!isNonEmptyString(provider)) {
      throw new IpcValidationError(IPC_CHANNELS.secrets.deleteKey, 'provider requerido');
    }
    return service.deleteKey(provider);
  });

  return service;
}
