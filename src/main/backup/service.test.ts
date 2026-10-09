import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BACKUP_RETENTION_COUNT } from '../../shared/journal';
import { openDatabase } from '../db/database';
import {
  BackupError,
  createBackupService,
  enforceRetention,
  ERR_BACKUP_CORRUPT,
  ERR_BACKUP_INVALID_NAME,
  ERR_BACKUP_NOT_FOUND,
  ERR_BACKUP_TOO_NEW,
  inspectBackup,
  lastScheduledOccurrence,
  LATEST_SCHEMA_VERSION,
  nextScheduledOccurrence,
  type BackupService,
} from './service';

const dirs: string[] = [];
const dbs: Database.Database[] = [];
const services: BackupService[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tradia-backup-'));
  dirs.push(dir);
  return dir;
}

function listBackupFileNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.db')) : [];
}

/** userData temporal con base migrada y servicio de copias encima. */
function harness(extra: Record<string, unknown> = {}) {
  const userData = tempDir();
  const dbPath = join(userData, 'tradia.db');
  const backupsDir = join(userData, 'backups');
  mkdirSync(backupsDir, { recursive: true });
  let db = openDatabase(dbPath);
  dbs.push(db);
  const restart = vi.fn();
  const service = createBackupService({
    dbPath,
    backupsDir,
    getDb: () => (db.open ? db : null),
    closeDb: () => {
      if (db.open) db.close();
    },
    reopenDb: () => {
      if (!db.open) {
        db = openDatabase(dbPath);
        dbs.push(db);
      }
    },
    restart,
    ...extra,
  });
  services.push(service);
  return {
    userData,
    dbPath,
    backupsDir,
    restart,
    service,
    getDb: () => db,
  };
}

const marker = (db: Database.Database, value: string): void => {
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'marcador',
    value,
    new Date().toISOString(),
  );
};

const markerValue = (dbPath: string): string | null => {
  const db = openDatabase(dbPath);
  const row = db.prepare("SELECT value FROM settings WHERE key = 'marcador'").get() as
    { value: string } | undefined;
  db.close();
  return row?.value ?? null;
};

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const db of dbs.splice(0)) {
    if (db.open) db.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('copias de seguridad', () => {
  it('crea una copia con nombre seguro, íntegra y con la versión de esquema', async () => {
    const { service, backupsDir, getDb } = harness();
    marker(getDb(), 'antes-de-la-copia');

    const info = await service.create();

    expect(info.fileName).toMatch(/^tradia-\d{8}-\d{6}\.db$/);
    expect(info.integrityOk).toBe(true);
    expect(info.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(info.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(join(backupsDir, info.fileName))).toBe(true);
    // La copia contiene los datos aunque la base siga abierta en WAL.
    expect(markerValue(join(backupsDir, info.fileName))).toBe('antes-de-la-copia');
  });

  it('lista las copias más recientes primero con su estado', async () => {
    const { service } = harness();
    const first = await service.create();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await service.create();

    const list = service.list();
    expect(list.map((b: { fileName: string }) => b.fileName)).toEqual([
      second.fileName,
      first.fileName,
    ]);
    expect(list[0]?.integrityOk).toBe(true);
  });

  it('mantiene solo las últimas copias (retención de 7)', async () => {
    const { service, backupsDir } = harness();
    for (let i = 0; i < BACKUP_RETENTION_COUNT + 2; i++) {
      await service.create();
      // mtimes distintas para que el orden de retención sea determinista.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const list = service.list();
    expect(list).toHaveLength(BACKUP_RETENTION_COUNT);
    expect(listBackupFileNames(backupsDir)).toHaveLength(BACKUP_RETENTION_COUNT);
    expect(list.every((b: { integrityOk: boolean }) => b.integrityOk)).toBe(true);
  });

  it('restaura en un userData limpio con los mismos datos y reinicia', async () => {
    // Origen: base con un dato reconocible del que se crea la copia.
    const origin = harness();
    marker(origin.getDb(), 'datos-origen');
    const backup = await origin.service.create();

    // Destino «instalación limpia»: otra base con datos distintos.
    const target = harness();
    marker(target.getDb(), 'datos-distintos');
    copyFileSync(
      join(origin.backupsDir, backup.fileName),
      join(target.backupsDir, backup.fileName),
    );

    const result = await target.service.restore(backup.fileName);

    expect(result).toEqual({ accepted: true });
    expect(target.restart).toHaveBeenCalledTimes(1);
    // La base restaurada tiene los datos del origen, no los del destino.
    expect(markerValue(target.dbPath)).toBe('datos-origen');
    // Y se guardó una copia previa del estado actual.
    const safety = listBackupFileNames(target.backupsDir).find((f) =>
      f.startsWith('tradia-pre-restauracion-'),
    );
    expect(safety).toBeDefined();
    expect(markerValue(join(target.backupsDir, safety as string))).toBe('datos-distintos');
  });

  it('rechaza una copia corrupta sin sustituir la base actual', async () => {
    const { service, backupsDir, dbPath, getDb, restart } = harness();
    marker(getDb(), 'intacto');
    writeFileSync(join(backupsDir, 'corrupta.db'), Buffer.from('no es sqlite', 'utf8'));

    await expect(service.restore('corrupta.db')).rejects.toThrowError(ERR_BACKUP_CORRUPT);
    expect(restart).not.toHaveBeenCalled();
    expect(getDb().open).toBe(true);
    expect(markerValue(dbPath)).toBe('intacto');
  });

  it('rechaza una copia de una versión de esquema más nueva', async () => {
    const { service, backupsDir } = harness();
    const info = await service.create();
    // Simula una copia de una app más nueva: esquema v999.
    const backupPath = join(backupsDir, info.fileName);
    const copy = new Database(backupPath);
    copy
      .prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      )
      .run(LATEST_SCHEMA_VERSION + 991, 'futura', 'x', new Date().toISOString());
    copy.close();

    await expect(service.restore(info.fileName)).rejects.toThrowError(ERR_BACKUP_TOO_NEW);
  });

  it('rechaza nombres inseguros o copias inexistentes', async () => {
    const { service } = harness();
    await expect(service.restore('../tradia.db')).rejects.toThrowError(ERR_BACKUP_INVALID_NAME);
    await expect(service.restore('inexistente.db')).rejects.toThrowError(ERR_BACKUP_NOT_FOUND);
    // Los errores de dominio usan la clase propia.
    await expect(service.restore('x.db')).rejects.toBeInstanceOf(BackupError);
  });

  it('programa la copia diaria y la crea de puesta al día si falta', async () => {
    // now = 10:00 locales: la última hora programada (02:00) ya pasó.
    const base = new Date();
    base.setHours(10, 0, 0, 0);
    let nowMs = base.getTime();
    const timers: { cb: () => void; delay: number }[] = [];
    const { service, backupsDir } = harness({
      now: () => nowMs,
      setTimer: (cb: () => void, delay: number) => {
        timers.push({ cb, delay });
        return { fake: true } as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });

    service.start();
    await vi.waitFor(() => {
      expect(service.list().length).toBeGreaterThan(0);
    });
    expect(service.list()[0]?.integrityOk).toBe(true);
    // Temporizador armado hasta la próxima 02:00.
    expect(timers).toHaveLength(1);
    const expectedDelay = nextScheduledOccurrence(nowMs, '02:00') - nowMs;
    expect(timers[0]?.delay).toBe(expectedDelay);

    // Al disparar el temporizador se crea la copia del día siguiente.
    const before = service.list().length;
    nowMs += expectedDelay + 1;
    timers[0]?.cb();
    await vi.waitFor(() => {
      expect(service.list().length).toBe(before + 1);
    });
    expect(listBackupFileNames(backupsDir)).toHaveLength(before + 1);
    service.stop();
  });

  it('no repite la copia si ya hay una posterior a la hora programada', async () => {
    const { service } = harness();
    await service.create();
    expect(await service.runIfDue()).toBeNull();
  });
});

describe('sonda de integridad y retención', () => {
  it('marca íntegras las copias buenas y detecta archivos ajenos', async () => {
    const { service, backupsDir } = harness();
    const info = await service.create();
    expect(inspectBackup(join(backupsDir, info.fileName))).toEqual({
      integrityOk: true,
      schemaVersion: LATEST_SCHEMA_VERSION,
    });
    const junk = join(backupsDir, 'basura.db');
    writeFileSync(junk, 'texto plano', 'utf8');
    expect(inspectBackup(junk).integrityOk).toBe(false);
  });

  it('enforceRetention borra solo el exceso más antiguo', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const names = ['a.db', 'b.db', 'c.db'];
    names.forEach((n, i) => {
      const path = join(dir, n);
      writeFileSync(path, 'x');
      const past = new Date(Date.now() - (names.length - i) * 60_000);
      utimesSync(path, past, past);
    });
    const removed = enforceRetention(dir, 2);
    expect(removed).toEqual(['a.db']);
    expect(listBackupFileNames(dir).sort()).toEqual(['b.db', 'c.db']);
  });
});

describe('ocurrencias de la hora programada', () => {
  it('calcula la última y la próxima ocurrencia de 02:00 local', () => {
    const at10 = new Date();
    at10.setHours(10, 0, 0, 0);
    const last = lastScheduledOccurrence(at10.getTime(), '02:00');
    const next = nextScheduledOccurrence(at10.getTime(), '02:00');
    expect(new Date(last).getHours()).toBe(2);
    expect(last).toBeLessThanOrEqual(at10.getTime());
    expect(next - last).toBe(86_400_000);
  });
});
