import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { app, ipcMain, shell } from 'electron';

import { IPC_CHANNELS, IpcValidationError, isBackupRestoreRequest } from '../../shared/ipc';
import { BACKUP_DIR_NAME, type OpenFolderResult } from '../../shared/journal';
import type { ServiceContext } from '../services';
import { getLogDir } from '../services/logger';
import { DB_FILENAME } from '../services/storage';
import { createBackupService, type BackupService } from './service';

/**
 * Copias de seguridad y registros (fase 4) — cableado del proceso
 * principal. La lógica vive en `./service.ts` (probable sin Electron).
 *
 * - `backup:list`/`backup:create`/`backup:restore` sobre
 *   `userData/backups`; la restauración guarda una copia del estado
 *   actual, sustituye `tradia.db` y reinicia (`app.relaunch` + `app.exit`).
 * - `logs:open-folder` abre `userData/logs` (registro rotado de
 *   `services/logger.ts`) con el explorador del sistema; devuelve la ruta
 *   para que ajustes pueda ofrecer «Copiar ruta» si el SO no la abre.
 * - Copia diaria a las `BACKUP_SCHEDULE_HHMM` (02:00 local): al arrancar
 *   se crea una de puesta al día si la última es anterior a la hora
 *   programada ya pasada.
 */
export function registerBackup(ctx: ServiceContext): BackupService {
  const userData = app.getPath('userData');
  const service = createBackupService({
    dbPath: ctx.services.storage?.dbPath ?? join(userData, DB_FILENAME),
    backupsDir: join(userData, BACKUP_DIR_NAME),
    getDb: () => ctx.services.storage?.getDb() ?? null,
    closeDb: () => ctx.services.storage?.close(),
    reopenDb: () => {
      void ctx.services.storage?.init();
    },
    restart: () => {
      app.relaunch();
      app.exit(0);
    },
  });

  ipcMain.handle(IPC_CHANNELS.backup.list, () => service.list());
  ipcMain.handle(IPC_CHANNELS.backup.create, () => service.create());
  ipcMain.handle(IPC_CHANNELS.backup.restore, (_event, request: unknown) => {
    if (!isBackupRestoreRequest(request)) {
      throw new IpcValidationError(
        IPC_CHANNELS.backup.restore,
        'se esperaba {fileName, confirm: true}',
      );
    }
    return service.restore(request.fileName);
  });
  ipcMain.handle(IPC_CHANNELS.logs.openFolder, async (): Promise<OpenFolderResult> => {
    const dir = getLogDir(userData);
    mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    return { ok: error === '', path: dir };
  });

  service.start();
  return service;
}

export type { BackupService } from './service';
