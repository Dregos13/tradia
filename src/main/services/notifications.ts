import { app, ipcMain, Notification } from 'electron';
import type { NotificationConstructorOptions } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isNotificationLevel,
  isNotificationPayload,
  isNotificationPrefs,
  type NotificationLevel,
  type NotificationPayload,
  type NotificationPrefs,
  type NotificationRoute,
} from '../../shared/ipc';
import { showMainWindow } from '../window';
import type { ServiceContext } from './index';

/**
 * Notificaciones nativas — único punto de envío de la app.
 *
 * Toda notificación del sistema sale por `notify()`: niveles
 * info/alerta/critica, preferencias por nivel persistidas en `settings`
 * (`notifications.prefs`), `urgency: 'critical'` en Linux para el nivel
 * crítica, `app.setAppUserModelId` en Windows (necesario para los toasts) y
 * clic que abre o enfoca la ventana principal. Si el SO no soporta
 * notificaciones se registra en el log y se descartan sin romper el flujo.
 */
export interface NotificationsService {
  /** Envía una notificación respetando las preferencias del nivel. */
  notify(payload: NotificationPayload): void;
  /** Envía una notificación de prueba del nivel indicado. */
  test(level: NotificationLevel): void;
  getPrefs(): NotificationPrefs;
  setPrefs(prefs: NotificationPrefs): NotificationPrefs;
}

/**
 * Mínimo de `Electron.Notification` que usa el servicio. Se inyecta para que
 * las pruebas lo simulen sin lanzar Electron (mismo patrón que SafeStorageLike
 * en secrets.ts).
 */
export interface NotificationLike {
  show(): void;
  close(): void;
  on(event: 'click', listener: () => void): this;
}

export interface NotificationCtorLike {
  new (options: NotificationConstructorOptions): NotificationLike;
  isSupported(): boolean;
}

export interface NotificationLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface NotificationsDeps {
  Notification: NotificationCtorLike;
  /** Preferencias por nivel (settings las persiste en SQLite). */
  getPrefs(): NotificationPrefs;
  setPrefs(prefs: NotificationPrefs): void;
  /** Abre o enfoca la ventana principal al hacer clic en la notificación. */
  focusMainWindow(): void;
  /**
   * Llevado tras enfocar cuando el payload trae `navigateTo`: abre la vista
   * pedida (el registro lo emite como evento `alerts:navigate` al renderer).
   */
  onNavigate?: (route: NotificationRoute) => void;
  /** Plataforma para urgency (Linux) y AppUserModelId (Windows). */
  platform?: NodeJS.Platform;
  /** Solo en Windows: app.setAppUserModelId para que los toasts funcionen. */
  setAppUserModelId?: (id: string) => void;
  logger?: NotificationLogger;
}

/**
 * AppUserModelId de Windows. Debe coincidir con el `appId` de
 * electron-builder cuando la tarea «packaging-ci» lo fije.
 */
export const APP_USER_MODEL_ID = 'com.tradia.app';

export function createNotificationsService(deps: NotificationsDeps): NotificationsService {
  const {
    Notification: NotificationCtor,
    getPrefs,
    setPrefs,
    focusMainWindow,
    onNavigate,
    setAppUserModelId,
    logger = console,
  } = deps;
  const platform = deps.platform ?? process.platform;
  let unsupportedLogged = false;

  // En Windows los toasts solo se muestran si la app tiene AppUserModelId.
  if (platform === 'win32' && setAppUserModelId) {
    setAppUserModelId(APP_USER_MODEL_ID);
  }

  const service: NotificationsService = {
    notify: (payload) => {
      // 'critica' vale true por defecto: solo se filtra con una
      // desactivación explícita en las preferencias.
      if (!getPrefs()[payload.level]) {
        logger.info(
          `[notifications] nivel '${payload.level}' desactivado; notificación descartada`,
        );
        return;
      }

      if (!NotificationCtor.isSupported()) {
        if (!unsupportedLogged) {
          unsupportedLogged = true;
          logger.warn('[notifications] el sistema no soporta notificaciones nativas');
        }
        return;
      }

      const options: NotificationConstructorOptions = {
        title: payload.title,
        body: payload.body,
      };
      if (platform === 'linux' && payload.level === 'critica') {
        options.urgency = 'critical';
      }

      try {
        const notification = new NotificationCtor(options);
        notification.on('click', () => {
          focusMainWindow();
          if (payload.navigateTo !== undefined) onNavigate?.(payload.navigateTo);
        });
        notification.show();
      } catch (error: unknown) {
        // Sin datos personales: solo el nivel y el error del sistema.
        logger.error(
          `[notifications] fallo al mostrar una notificación de nivel '${payload.level}': ${String(error)}`,
        );
      }
    },
    test: (level) => {
      service.notify({
        level,
        title: 'Prueba de Tradia',
        body: `Esta es una notificación de prueba (nivel: ${level}).`,
      });
    },
    getPrefs: () => getPrefs(),
    setPrefs: (next) => {
      setPrefs(next);
      return getPrefs();
    },
  };

  return service;
}

export function registerNotifications(ctx: ServiceContext): NotificationsService {
  // Las preferencias viven en settings (tabla `settings`, clave
  // 'notifications.prefs'); si settings no está registrado se usa memoria.
  const settings = ctx.services.settings;
  let memoryPrefs: NotificationPrefs = { info: true, alerta: true, critica: true };

  const service = createNotificationsService({
    Notification,
    getPrefs: () => settings?.getNotificationPrefs() ?? { ...memoryPrefs },
    setPrefs: (prefs) => {
      if (settings) {
        settings.setNotificationPrefs(prefs);
      } else {
        memoryPrefs = { ...prefs };
      }
    },
    focusMainWindow: showMainWindow,
    // El clic con `navigateTo` pide la vista al renderer por broadcast; el
    // preload la traduce a la ruta por hash (#noticias / #calendario).
    onNavigate: (route) => ctx.broadcast(IPC_CHANNELS.alerts.navigate, route),
    platform: process.platform,
    setAppUserModelId: (id) => app.setAppUserModelId(id),
  });

  ipcMain.handle(IPC_CHANNELS.notifications.send, (_event, payload: unknown) => {
    if (!isNotificationPayload(payload)) {
      throw new IpcValidationError(IPC_CHANNELS.notifications.send, 'payload inválido');
    }
    service.notify(payload);
  });
  ipcMain.handle(IPC_CHANNELS.notifications.test, (_event, level: unknown) => {
    if (!isNotificationLevel(level)) {
      throw new IpcValidationError(IPC_CHANNELS.notifications.test, 'nivel inválido');
    }
    service.test(level);
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
