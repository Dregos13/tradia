import type { ServiceContext } from '../services';

/**
 * Copias de seguridad y registros (fase 4) — esqueleto del contrato
 * compartido.
 *
 * Ya está registrado en `services/index.ts` y se detiene en el `will-quit`
 * de `index.ts`, así la tarea «copias-y-registros» implementa aquí sin
 * tocar el cableado: copia diaria programada con la API de copia de
 * better-sqlite3 hacia `userData/backups` (`BACKUP_DIR_NAME`), retención
 * de las últimas `BACKUP_RETENTION_COUNT`, copia manual, comprobación de
 * integridad y restauración con copia previa del estado actual.
 *
 * Los tipos y canales fijados están en `src/shared/journal.ts` y
 * `src/shared/ipc.ts` (`backup:list`, `backup:create`, `backup:restore` y
 * `logs:open-folder` para la carpeta de registros rotados).
 */
export interface BackupService {
  stop(): void;
}

export function registerBackup(_ctx: ServiceContext): BackupService {
  return {
    stop: () => undefined,
  };
}
