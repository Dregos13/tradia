import type Database from 'better-sqlite3';
import { ipcMain } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isNotificationPrefs,
  isSettingsPatch,
  type AppSettings,
  type NotificationPrefs,
  type SettingsPatch,
} from '../../shared/ipc';
import type { ServiceContext } from './index';
import { applyOsAutostart, readOsAutostart } from './tray';

/**
 * Ajustes de la app, persistidos en la tabla `settings` (clave-valor, sin
 * secretos). Si el almacén no está disponible se degrada a memoria para que
 * el resto de la app siga funcionando durante la sesión.
 *
 * Claves conocidas: `autostart`, `disclaimerAcceptedVersion` y
 * `notifications.prefs`. `getValue`/`setValue` quedan para uso interno del
 * proceso principal (p. ej. el servicio de notificaciones); el IPC solo
 * acepta `SettingsPatch` validado.
 */
export interface SettingsService {
  get(): AppSettings;
  set(patch: SettingsPatch): AppSettings;
  getNotificationPrefs(): NotificationPrefs;
  setNotificationPrefs(prefs: NotificationPrefs): void;
  /** Almacén clave-valor interno; no se expone por IPC. */
  getValue(key: string): string | null;
  setValue(key: string, value: string): void;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  info: true,
  alerta: true,
  critica: true,
};

const KEYS = {
  autostart: 'autostart',
  disclaimerAcceptedVersion: 'disclaimerAcceptedVersion',
  disclaimerAcceptedAt: 'disclaimerAcceptedAt',
  notificationPrefs: 'notifications.prefs',
} as const;

interface KeyValueStore {
  getValue(key: string): string | null;
  setValue(key: string, value: string): void;
}

function sqliteStore(db: Database.Database): KeyValueStore {
  const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setStmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  return {
    getValue: (key) => {
      const row = getStmt.get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    setValue: (key, value) => {
      setStmt.run(key, value, new Date().toISOString());
    },
  };
}

function memoryStore(): KeyValueStore {
  const entries = new Map<string, string>();
  return {
    getValue: (key) => entries.get(key) ?? null,
    setValue: (key, value) => {
      entries.set(key, value);
    },
  };
}

export function createSettingsService(db: Database.Database | null): SettingsService {
  if (!db) {
    console.warn('[settings] almacén no disponible: los ajustes solo vivirán en memoria');
  }
  const store = db ? sqliteStore(db) : memoryStore();

  const service: SettingsService = {
    get: () => ({
      autostart: store.getValue(KEYS.autostart) === 'true',
      disclaimerAcceptedVersion: store.getValue(KEYS.disclaimerAcceptedVersion) || null,
      disclaimerAcceptedAt: store.getValue(KEYS.disclaimerAcceptedAt) || null,
    }),
    set: (patch) => {
      if (patch.autostart !== undefined) {
        store.setValue(KEYS.autostart, String(patch.autostart));
        // La tarea «tray-background» aplica app.setLoginItemSettings con este valor.
      }
      if (patch.disclaimerAcceptedVersion !== undefined) {
        // La guarda IPC admite null como "restablecer": se guarda '' (NOT NULL).
        const saveAcceptance = () => {
          store.setValue(KEYS.disclaimerAcceptedVersion, patch.disclaimerAcceptedVersion ?? '');
          store.setValue(
            KEYS.disclaimerAcceptedAt,
            patch.disclaimerAcceptedVersion ? new Date().toISOString() : '',
          );
        };
        if (db) db.transaction(saveAcceptance)();
        else saveAcceptance();
      }
      return service.get();
    },
    getNotificationPrefs: () => {
      const raw = store.getValue(KEYS.notificationPrefs);
      if (raw === null) return { ...DEFAULT_NOTIFICATION_PREFS };
      try {
        const parsed: unknown = JSON.parse(raw);
        return isNotificationPrefs(parsed) ? { ...parsed } : { ...DEFAULT_NOTIFICATION_PREFS };
      } catch {
        return { ...DEFAULT_NOTIFICATION_PREFS };
      }
    },
    setNotificationPrefs: (prefs) => {
      store.setValue(KEYS.notificationPrefs, JSON.stringify(prefs));
    },
    getValue: store.getValue,
    setValue: store.setValue,
  };

  return service;
}

export function registerSettings(ctx: ServiceContext): SettingsService {
  const service = createSettingsService(ctx.services.storage?.getDb() ?? null);

  const actualSettings = () => ({ ...service.get(), autostart: readOsAutostart() });
  ipcMain.handle(IPC_CHANNELS.settings.get, actualSettings);
  ipcMain.handle(IPC_CHANNELS.settings.set, (_event, patch: unknown) => {
    if (!isSettingsPatch(patch)) {
      throw new IpcValidationError(IPC_CHANNELS.settings.set, 'patch de ajustes inválido');
    }
    if (patch.autostart !== undefined) applyOsAutostart(patch.autostart);
    service.set(patch);
    ctx.services.tray?.refresh();
    return actualSettings();
  });

  return service;
}
