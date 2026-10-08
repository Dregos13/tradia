import { ipcMain } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isSettingsPatch,
  type AppSettings,
  type SettingsPatch,
} from '../../shared/ipc';
import type { ServiceContext } from './index';

/**
 * Ajustes de la app — stub en memoria.
 *
 * La tarea «storage-db» lo implementa con persistencia (JSON o tabla,
 * sin secretos). Claves: autostart y versión del aviso de riesgo aceptada.
 */
export interface SettingsService {
  get(): AppSettings;
  set(patch: SettingsPatch): AppSettings;
}

const DEFAULT_SETTINGS: AppSettings = {
  autostart: false,
  disclaimerAcceptedVersion: null,
};

export function registerSettings(_ctx: ServiceContext): SettingsService {
  // TODO(storage-db): cargar de disco y persistir cada cambio; aplicar autostart real.
  let current: AppSettings = { ...DEFAULT_SETTINGS };

  const service: SettingsService = {
    get: () => ({ ...current }),
    set: (patch) => {
      current = { ...current, ...patch };
      return { ...current };
    },
  };

  ipcMain.handle(IPC_CHANNELS.settings.get, () => service.get());
  ipcMain.handle(IPC_CHANNELS.settings.set, (_event, patch: unknown) => {
    if (!isSettingsPatch(patch)) {
      throw new IpcValidationError(IPC_CHANNELS.settings.set, 'patch de ajustes inválido');
    }
    return service.set(patch);
  });

  return service;
}
