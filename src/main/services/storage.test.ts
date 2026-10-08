import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ServiceContext } from './index';
import { DB_FILENAME, registerStorage, type StorageService } from './storage';

const ctx: ServiceContext = { broadcast: () => {}, services: {} };

const dirs: string[] = [];
const services: StorageService[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tradia-test-'));
  dirs.push(dir);
  return dir;
}

function createStorage(dbFile: string): StorageService {
  const service = registerStorage(ctx, { dbFile });
  services.push(service);
  return service;
}

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('servicio de almacenamiento', () => {
  it('crea el archivo, ejecuta migraciones y queda listo', () => {
    const dbFile = join(tempDir(), 'subdir', DB_FILENAME);
    const storage = createStorage(dbFile);

    expect(storage.ready).toBe(true);
    expect(storage.dbPath).toBe(dbFile);
    expect(storage.getDb()!.open).toBe(true);

    const tables = storage
      .getDb()!
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['series', 'noticias', 'senales', 'diario', 'settings', 'secrets']),
    );
  });

  it('sobrevive a un reinicio: reabre el mismo archivo sin aplicar migraciones dos veces', () => {
    const dir = tempDir();
    const dbFile = join(dir, DB_FILENAME);
    const first = createStorage(dbFile);
    first
      .getDb()!
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('k', 'v', new Date().toISOString());
    first.close();

    const second = createStorage(dbFile);
    expect(second.ready).toBe(true);
    const row = second.getDb()!.prepare('SELECT value FROM settings WHERE key = ?').get('k') as
      { value: string } | undefined;
    expect(row?.value).toBe('v');
  });

  it('marca ready=false si el archivo no puede abrirse, sin tumbar la app', () => {
    // Un archivo normal donde debería haber un directorio provoca ENOTDIR.
    const dir = tempDir();
    const blocker = join(dir, 'bloqueo');
    writeFileSync(blocker, 'x');
    const storage = createStorage(join(blocker, DB_FILENAME));

    expect(storage.ready).toBe(false);
    expect(storage.getDb()).toBeNull();
    storage.init(); // reintenta y sigue fallando sin lanzar
    return storage.init().then(() => expect(storage.ready).toBe(false));
  });

  it('init es idempotente y close libera la base de datos', async () => {
    const storage = createStorage(join(tempDir(), DB_FILENAME));
    await storage.init();
    await storage.init();
    expect(storage.ready).toBe(true);

    storage.close();
    expect(storage.ready).toBe(false);
    storage.close(); // cerrar dos veces no falla
  });
});
