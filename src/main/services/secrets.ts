import type Database from 'better-sqlite3';
import { ipcMain, safeStorage } from 'electron';

import { IPC_CHANNELS, IpcValidationError, isNonEmptyString } from '../../shared/ipc';
import { InvalidStoredKeyError } from '../market/providers/types';
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
  /**
   * Solo uso interno del proceso principal; nunca se expone por IPC.
   * Una clave guardada con controles o espacios dentro (anterior a la
   * validación de `setKey`) se marca como no válida: rechaza con
   * `InvalidStoredKeyError` en vez de devolver una credencial que rompe
   * las cabeceras HTTP y se cita en el error de transporte.
   */
  getKey(provider: string): Promise<string | null>;
}

/** true si el carácter es control (C0/C1) o espacio: no cabe en una clave. */
const isUnsafeKeyChar = (char: string): boolean => {
  const code = char.codePointAt(0)!;
  return code <= 0x20 || (code >= 0x7f && code <= 0x9f);
};

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
      // Una clave pegada con espacios o controles alrededor se recorta;
      // si el resto lleva controles/espacios dentro es un error de
      // copiado: se rechaza en vez de guardar una credencial que rompe
      // las cabeceras HTTP y cita su valor en el error de transporte.
      const cleaned = apiKey.trim();
      if (cleaned === '') {
        throw new SecretsError('la clave está vacía');
      }
      if ([...cleaned].some(isUnsafeKeyChar)) {
        throw new SecretsError(
          'la clave contiene espacios o caracteres de control: revisa el copiado',
        );
      }
      const ciphertext = crypto.encryptString(cleaned).toString('base64');
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
      let key: string;
      try {
        key = crypto.decryptString(Buffer.from(row.ciphertext, 'base64'));
      } catch {
        throw new SecretsError(
          `no se pudo descifrar la clave de '${provider}': el cifrado del sistema cambió o el dato está corrupto`,
        );
      }
      // Claves guardadas antes de la validación de `setKey` (o por otra
      // vía) pueden llevar controles: devolverlas rompería la cabecera
      // HTTP y el error de transporte las citaría. Se marcan como no
      // válidas: hay que volver a pegarlas, no hay «sin conexión».
      if ([...key].some(isUnsafeKeyChar)) {
        throw new InvalidStoredKeyError({ provider });
      }
      return key;
    },
  };
}

export function registerSecrets(ctx: ServiceContext): SecretsService {
  const service = createSecretsService(ctx.services.storage?.getDb() ?? null, safeStorage);

  ipcMain.handle(IPC_CHANNELS.secrets.setKey, (_event, provider: unknown, apiKey: unknown) => {
    if (!isNonEmptyString(provider) || !isNonEmptyString(apiKey)) {
      throw new IpcValidationError(IPC_CHANNELS.secrets.setKey, 'provider y apiKey requeridos');
    }
    return service.setKey(provider, apiKey).then(() => {
      // Tras guardar la clave los proveedores de datos lanzan su primer
      // refresco (la envoltura de ctx.broadcast lo observa). Solo va el
      // nombre del proveedor, nunca la clave.
      ctx.broadcast(IPC_CHANNELS.secrets.changed, { provider });
    });
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
    return service.deleteKey(provider).then(() => {
      ctx.broadcast(IPC_CHANNELS.secrets.changed, { provider });
    });
  });

  return service;
}
