import { ipcMain } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isNotificationLevel,
  isNotificationPayload,
  isNotificationPrefs,
  type NotificationLevel,
  type NotificationPayload,
  type NotificationPrefs,
} from '../../shared/ipc';
import type { ServiceContext } from './index';

/**
 * Notificaciones nativas — stub que registra en el log.
 *
 * La tarea «notifications-service» lo implementa como único punto de envío
 * (Notification de Electron, niveles info/alerta/critica, preferencias por
 * nivel, app.setAppUserModelId en Windows, clic enfoca la ventana).
 */
export interface NotificationsService {
  send(payload: NotificationPayload): Promise<void>;
  test(level: NotificationLevel): Promise<void>;
  getPrefs(): NotificationPrefs;
  setPrefs(prefs: NotificationPrefs): NotificationPrefs;
}

const DEFAULT_PREFS: NotificationPrefs = { info: true, alerta: true, critica: true };

export function registerNotifications(_ctx: ServiceContext): NotificationsService {
  // TODO(storage-db/notifications-service): persistir preferencias vía settings/storage.
  let prefs: NotificationPrefs = { ...DEFAULT_PREFS };

  const service: NotificationsService = {
    send: (payload) => {
      // TODO(notifications-service): new Notification(...) respetando prefs y nivel.
      console.log(`[notifications:stub] ${payload.level}: ${payload.title}`);
      return Promise.resolve();
    },
    test: (level) => service.send({ level, title: 'Prueba de Tradia', body: `Nivel: ${level}` }),
    getPrefs: () => ({ ...prefs }),
    setPrefs: (next) => {
      prefs = { ...next };
      return { ...prefs };
    },
  };

  ipcMain.handle(IPC_CHANNELS.notifications.send, (_event, payload: unknown) => {
    if (!isNotificationPayload(payload)) {
      throw new IpcValidationError(IPC_CHANNELS.notifications.send, 'payload inválido');
    }
    return service.send(payload);
  });
  ipcMain.handle(IPC_CHANNELS.notifications.test, (_event, level: unknown) => {
    if (!isNotificationLevel(level)) {
      throw new IpcValidationError(IPC_CHANNELS.notifications.test, 'nivel inválido');
    }
    return service.test(level);
  });
  ipcMain.handle(IPC_CHANNELS.notifications.getPrefs, () => service.getPrefs());
  ipcMain.handle(IPC_CHANNELS.notifications.setPrefs, (_event, next: unknown) => {
    if (!isNotificationPrefs(next)) {
      throw new IpcValidationError(IPC_CHANNELS.notifications.setPrefs, 'preferencias inválidas');
    }
    return service.setPrefs(next);
  });

  return service;
}
