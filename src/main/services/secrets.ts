import { ipcMain } from 'electron';

import { IPC_CHANNELS, IpcValidationError, isNonEmptyString } from '../../shared/ipc';
import type { ServiceContext } from './index';

/**
 * Claves de API cifradas — stub.
 *
 * La tarea «storage-db» lo implementa con safeStorage.encryptString y
 * persistencia en base64. Si el cifrado del sistema no está disponible,
 * falla con un error claro: nunca guarda claves en texto plano.
 * El renderer puede escribir, comprobar y borrar, pero NO leer (sin getKey
 * por IPC; solo el proceso principal puede recuperar la clave).
 */
export interface SecretsService {
  setKey(provider: string, apiKey: string): Promise<void>;
  hasKey(provider: string): Promise<boolean>;
  deleteKey(provider: string): Promise<void>;
  /** Solo uso interno del proceso principal; nunca se expone por IPC. */
  getKey(provider: string): Promise<string | null>;
}

const NOT_IMPLEMENTED = 'secrets: pendiente de implementación (tarea storage-db)';

export function registerSecrets(_ctx: ServiceContext): SecretsService {
  const service: SecretsService = {
    setKey: () => Promise.reject(new Error(NOT_IMPLEMENTED)),
    hasKey: () => Promise.resolve(false),
    deleteKey: () => Promise.reject(new Error(NOT_IMPLEMENTED)),
    getKey: () => Promise.resolve(null),
  };

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
