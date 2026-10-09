import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import {
  BACKUP_FILE_PATTERN,
  BACKUP_RETENTION_COUNT,
  BACKUP_SCHEDULE_HHMM,
  type BackupInfo,
  type BackupRestoreResult,
} from '../../shared/journal';
import { MIGRATIONS } from '../db/migrations';

/**
 * Copias de seguridad de la base local (fase 4) — núcleo sin Electron.
 *
 * `createBackupService` trabaja sobre rutas y dependencias inyectadas, así
 * las pruebas lo ejercitan con `userData` temporales; `registerBackup`
 * (`./index.ts`) lo cablea con `app`, `shell`, `ipcMain` y el almacén.
 *
 * - Copia con la API online de better-sqlite3 (`db.backup`), válida con la
 *   base abierta en modo WAL, hacia `userData/backups/tradia-*.db`.
 * - Retención: se conservan las `BACKUP_RETENTION_COUNT` (7) copias más
 *   recientes; las demás se borran tras cada copia.
 * - Integridad: `PRAGMA integrity_check` y versión de esquema
 *   (`MAX(schema_migrations.version)`), leídos abriendo la copia en modo
 *   solo lectura.
 * - Restauración: exige nombre de archivo seguro (`BACKUP_FILE_PATTERN`),
 *   copia íntegra y esquema no más nuevo que el conocido; primero guarda
 *   una copia del estado actual (`tradia-pre-restauracion-*.db`), sustituye
 *   el archivo con la base cerrada y reinicia la app.
 * - Programación diaria a `BACKUP_SCHEDULE_HHMM` ('02:00', hora local):
 *   al arrancar, si no hay copia posterior a la última hora programada ya
 *   pasada, se crea una de compensación; después un temporizador repite
 *   cada día.
 */

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export const ERR_BACKUP_INVALID_NAME = 'nombre de copia inválido';
export const ERR_BACKUP_NOT_FOUND = 'la copia no existe';
export const ERR_BACKUP_CORRUPT = 'la copia está corrupta o no es una base de datos de Tradia';
export const ERR_BACKUP_TOO_NEW =
  'la copia pertenece a una versión de Tradia más nueva; actualiza la app para restaurarla';
export const ERR_BACKUP_DB_UNAVAILABLE = 'la base de datos no está disponible';

/** Última versión de esquema que conoce esta instalación. */
export const LATEST_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface BackupLogger {
  info?(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface BackupServiceDeps {
  /** Ruta de la base activa (`storage.dbPath`); ':memory:' desactiva la copia de archivo. */
  dbPath: string;
  /** Carpeta de copias (`userData/backups`). */
  backupsDir: string;
  /** Base abierta para la copia online; null si el almacén falló. */
  getDb(): Database.Database | null;
  /** Cierra la base antes de sustituir el archivo (`storage.close`). */
  closeDb?(): void;
  /** Reabre la base si la sustitución falla antes del reinicio (`storage.init`). */
  reopenDb?(): void;
  /** Reinicia la app tras sustituir (`app.relaunch` + `app.exit`). */
  restart?(): void;
  /** Copias conservadas; por defecto BACKUP_RETENTION_COUNT. */
  retentionCount?: number;
  /** Hora de la copia diaria ('HH:MM', local); por defecto BACKUP_SCHEDULE_HHMM. */
  scheduleHHMM?: string;
  /** Versión de esquema máxima restaurable; por defecto la de la app. */
  knownSchemaVersion?: number;
  /** Reloj inyectable (ms epoch). */
  now?: () => number;
  /** Temporizadores inyectables para las pruebas. */
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  logger?: BackupLogger;
}

export interface BackupService {
  /** Copias presentes, más recientes primero, con integridad y esquema. */
  list(): BackupInfo[];
  /** Copia manual inmediata (y retención). Devuelve su ficha. */
  create(): Promise<BackupInfo>;
  /**
   * Restaura una copia: valida integridad y versión, guarda una copia del
   * estado actual, sustituye el archivo de la base y reinicia la app.
   */
  restore(fileName: string): Promise<BackupRestoreResult>;
  /**
   * Crea una copia si la última es anterior a la última hora programada ya
   * pasada (puesta al día tras arrancar la app). null si no tocaba.
   */
  runIfDue(): Promise<BackupInfo | null>;
  /** Puesta al día + temporizador diario. */
  start(): void;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Utilidades de archivos y sonda de copias
// ---------------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 'YYYYMMDD-HHmmss' en hora local, para nombres de archivo ordenables. */
function fileStamp(epochMs: number): string {
  const d = new Date(epochMs);
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

interface BackupFileEntry {
  fileName: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

/** Archivos de copia (patrón seguro) ordenados del más reciente al más antiguo. */
function listBackupFiles(backupsDir: string): BackupFileEntry[] {
  if (!existsSync(backupsDir)) return [];
  const entries: BackupFileEntry[] = [];
  for (const fileName of readdirSync(backupsDir)) {
    if (!BACKUP_FILE_PATTERN.test(fileName) || fileName.includes('..')) continue;
    const path = join(backupsDir, fileName);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      entries.push({
        fileName,
        path,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    } catch {
      // Archivo que desaparece mientras se lista: se ignora.
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.fileName.localeCompare(a.fileName));
  return entries;
}

/** Integridad (`PRAGMA integrity_check`) y versión de esquema de una copia. */
export function inspectBackup(path: string): {
  integrityOk: boolean;
  schemaVersion: number;
} {
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const rows = db.pragma('integrity_check') as { integrity_check: string }[];
    const integrityOk = rows.length === 1 && rows[0]?.integrity_check === 'ok';
    let schemaVersion = 0;
    try {
      const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
        v: number | null;
      };
      schemaVersion = row?.v ?? 0;
    } catch {
      schemaVersion = 0;
    }
    return { integrityOk, schemaVersion };
  } catch {
    return { integrityOk: false, schemaVersion: 0 };
  } finally {
    try {
      db?.close();
    } catch {
      // Cierre a la fuerza innecesario en sonda de solo lectura.
    }
  }
}

/** Borra las copias más antiguas que superen `keep`. Devuelve los nombres borrados. */
export function enforceRetention(backupsDir: string, keep: number): string[] {
  const excess = listBackupFiles(backupsDir).slice(Math.max(0, keep));
  for (const entry of excess) {
    try {
      rmSync(entry.path, { force: true });
    } catch {
      // Si no se puede borrar, la retención se reintenta en la próxima copia.
    }
  }
  return excess.map((e) => e.fileName);
}

// ---------------------------------------------------------------------------
// Programación diaria ('HH:MM' en hora local)
// ---------------------------------------------------------------------------

function parseHHMM(hhmm: string): { hours: number; minutes: number } {
  const parts = hhmm.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  return {
    hours: Number.isFinite(h) && h >= 0 && h <= 23 ? h : 2,
    minutes: Number.isFinite(m) && m >= 0 && m <= 59 ? m : 0,
  };
}

/** Próxima ocurrencia estrictamente futura de la hora programada. */
export function nextScheduledOccurrence(nowMs: number, hhmm: string): number {
  const { hours, minutes } = parseHHMM(hhmm);
  const d = new Date(nowMs);
  d.setHours(hours, minutes, 0, 0);
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Última ocurrencia ya pasada (o exactamente ahora) de la hora programada. */
export function lastScheduledOccurrence(nowMs: number, hhmm: string): number {
  const { hours, minutes } = parseHHMM(hhmm);
  const d = new Date(nowMs);
  d.setHours(hours, minutes, 0, 0);
  if (d.getTime() > nowMs) d.setDate(d.getDate() - 1);
  return d.getTime();
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export function createBackupService(deps: BackupServiceDeps): BackupService {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h: TimerHandle) => clearTimeout(h));
  const logger = deps.logger ?? console;
  const retention = deps.retentionCount ?? BACKUP_RETENTION_COUNT;
  const scheduleHHMM = deps.scheduleHHMM ?? BACKUP_SCHEDULE_HHMM;
  const knownSchemaVersion = deps.knownSchemaVersion ?? LATEST_SCHEMA_VERSION;

  // Restos de una sustitución interrumpida por un cierre inesperado: el
  // archivo temporal no llegó a reemplazar la base, que sigue intacta.
  if (deps.dbPath !== ':memory:') {
    try {
      rmSync(`${deps.dbPath}.restaurando`, { force: true });
    } catch {
      // Sin permisos o ruta inaccesible: no impide el servicio.
    }
  }

  let timer: TimerHandle | null = null;
  let started = false;
  // Cola interna: las operaciones que escriben (copia manual, programada,
  // de puesta al día y restauración) nunca corren en paralelo, así dos
  // copias no pueden elegir el mismo nombre ni cerrarse la base a medias.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job, job);
    queue = run.catch(() => undefined);
    return run;
  };

  const list = (): BackupInfo[] =>
    listBackupFiles(deps.backupsDir).map((entry) => ({
      fileName: entry.fileName,
      sizeBytes: entry.sizeBytes,
      createdAt: new Date(entry.mtimeMs).toISOString(),
      ...inspectBackup(entry.path),
    }));

  const doCreate = async (): Promise<BackupInfo> => {
    const db = deps.getDb();
    if (!db?.open) throw new BackupError(ERR_BACKUP_DB_UNAVAILABLE);
    mkdirSync(deps.backupsDir, { recursive: true });

    const stamp = fileStamp(now());
    let fileName = `tradia-${stamp}.db`;
    for (let i = 2; existsSync(join(deps.backupsDir, fileName)); i++) {
      fileName = `tradia-${stamp}-${i}.db`;
    }
    const path = join(deps.backupsDir, fileName);
    await db.backup(path);

    const removed = enforceRetention(deps.backupsDir, retention);
    if (removed.length > 0) {
      logger.info?.(`[backup] retención: ${removed.length} copia(s) antiguas eliminadas`);
    }
    const stat = statSync(path);
    const probe = inspectBackup(path);
    logger.info?.(`[backup] copia creada: ${fileName} (${stat.size} bytes)`);
    return {
      fileName,
      sizeBytes: stat.size,
      createdAt: stat.mtime.toISOString(),
      ...probe,
    };
  };

  const doRestore = async (fileName: string): Promise<BackupRestoreResult> => {
    if (
      typeof fileName !== 'string' ||
      !BACKUP_FILE_PATTERN.test(fileName) ||
      fileName.includes('..')
    ) {
      throw new BackupError(ERR_BACKUP_INVALID_NAME);
    }
    const source = join(deps.backupsDir, fileName);
    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new BackupError(ERR_BACKUP_NOT_FOUND);
    }
    const probe = inspectBackup(source);
    if (!probe.integrityOk) throw new BackupError(ERR_BACKUP_CORRUPT);
    if (probe.schemaVersion > knownSchemaVersion) {
      throw new BackupError(
        `${ERR_BACKUP_TOO_NEW} (esquema v${probe.schemaVersion} > v${knownSchemaVersion})`,
      );
    }
    if (deps.dbPath === ':memory:') {
      throw new BackupError(ERR_BACKUP_DB_UNAVAILABLE);
    }

    // 1. Copia de seguridad del estado actual, antes de tocar nada.
    const db = deps.getDb();
    if (existsSync(deps.dbPath)) {
      const safetyPath = join(deps.backupsDir, `tradia-pre-restauracion-${fileStamp(now())}.db`);
      mkdirSync(deps.backupsDir, { recursive: true });
      if (db?.open) {
        await db.backup(safetyPath);
      } else {
        copyFileSync(deps.dbPath, safetyPath);
      }
      logger.info?.('[backup] estado actual guardado antes de restaurar');
    }

    // 2. Sustitución con la base cerrada: el archivo original queda intacto
    //    hasta que el relevo (rename) tiene éxito.
    deps.closeDb?.();
    try {
      for (const suffix of ['-wal', '-shm', '-journal']) {
        rmSync(deps.dbPath + suffix, { force: true });
      }
      const tmp = `${deps.dbPath}.restaurando`;
      copyFileSync(source, tmp);
      renameSync(tmp, deps.dbPath);
    } catch (error) {
      // «La base actual no se ha sustituido»: reabrir y propagar.
      try {
        deps.reopenDb?.();
      } catch {
        // Si tampoco reabre, el arranque lo reintentará y lo registrará.
      }
      throw error;
    }

    // 3. Retención (incluye la copia previa a la restauración) y reinicio.
    enforceRetention(deps.backupsDir, retention);
    logger.info?.(`[backup] copia restaurada: ${fileName}; reiniciando`);
    deps.restart?.();
    return { accepted: true };
  };

  const runIfDue = async (): Promise<BackupInfo | null> =>
    enqueue(async () => {
      const dueAt = lastScheduledOccurrence(now(), scheduleHHMM);
      const latest = listBackupFiles(deps.backupsDir)[0];
      if (latest && latest.mtimeMs >= dueAt) return null;
      return doCreate();
    });

  const arm = (): void => {
    if (!started) return;
    const delay = Math.max(0, nextScheduledOccurrence(now(), scheduleHHMM) - now());
    timer = setTimer(() => {
      timer = null;
      void enqueue(doCreate)
        .catch((error: unknown) =>
          logger.warn('[backup] la copia programada falló:', String(error)),
        )
        .finally(arm);
    }, delay);
    (timer as { unref?: () => void }).unref?.();
  };

  return {
    list,
    create: () => enqueue(doCreate),
    restore: (fileName) => enqueue(() => doRestore(fileName)),
    runIfDue,
    start: () => {
      if (started) return;
      started = true;
      void runIfDue().catch((error: unknown) =>
        logger.warn('[backup] la copia de puesta al día falló:', String(error)),
      );
      arm();
    },
    stop: () => {
      started = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
