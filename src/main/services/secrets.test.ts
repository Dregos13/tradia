import type Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../../shared/ipc';
import { openDatabase } from '../db/database';
import { InvalidStoredKeyError } from '../market/providers/types';
import {
  createSecretsService,
  ERR_ENCRYPTION_UNAVAILABLE,
  ERR_STORAGE_UNAVAILABLE,
  registerSecrets,
  SecretsError,
  type SafeStorageLike,
} from './secrets';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from([...plain].reverse().join(''), 'utf8'),
    decryptString: (encrypted: Buffer) => [...encrypted.toString('utf8')].reverse().join(''),
  },
}));

const SAMPLE_KEY = 'sk-test-CLAVE-SECRETA-0123456789';

/** safeStorage simulado: cifrado reversible que nunca contiene el texto plano. */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from([...plain].reverse().join(''), 'utf8'),
    decryptString: (encrypted) => [...encrypted.toString('utf8')].reverse().join(''),
  };
}

const dirs: string[] = [];
const dbs: Database.Database[] = [];

function fileDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tradia-secrets-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'tradia.db'));
  dbs.push(db);
  return { db, dir };
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    if (db.open) db.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('servicio de claves cifradas', () => {
  it('guarda, comprueba, recupera (solo main) y borra una clave', async () => {
    const { db } = fileDb();
    const secrets = createSecretsService(db, fakeSafeStorage());

    expect(await secrets.hasKey('proveedor')).toBe(false);
    await secrets.setKey('proveedor', SAMPLE_KEY);

    expect(await secrets.hasKey('proveedor')).toBe(true);
    expect(await secrets.getKey('proveedor')).toBe(SAMPLE_KEY);

    await secrets.deleteKey('proveedor');
    expect(await secrets.hasKey('proveedor')).toBe(false);
    expect(await secrets.getKey('proveedor')).toBeNull();
  });

  it('sobrescribe una clave existente para el mismo proveedor', async () => {
    const { db } = fileDb();
    const secrets = createSecretsService(db, fakeSafeStorage());

    await secrets.setKey('proveedor', 'clave-vieja');
    await secrets.setKey('proveedor', SAMPLE_KEY);

    expect(await secrets.getKey('proveedor')).toBe(SAMPLE_KEY);
  });

  it('nunca escribe la clave en texto plano en disco ni en la base de datos', async () => {
    const { db, dir } = fileDb();
    const secrets = createSecretsService(db, fakeSafeStorage());
    await secrets.setKey('alphavantage', SAMPLE_KEY);

    // El registro existe pero su valor almacenado no es legible.
    const row = db
      .prepare('SELECT ciphertext FROM secrets WHERE provider = ?')
      .get('alphavantage') as { ciphertext: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.ciphertext).not.toContain(SAMPLE_KEY);

    // Ningún archivo del directorio de datos (db, wal, shm, ajustes…) lo contiene.
    db.close();
    for (const file of readdirSync(dir)) {
      const contents = readFileSync(join(dir, file));
      expect(contents.includes(SAMPLE_KEY), `la clave quedó legible en ${file}`).toBe(false);
    }
  });

  it('rechaza guardar cuando el cifrado del sistema no está disponible', async () => {
    const { db } = fileDb();
    const secrets = createSecretsService(db, fakeSafeStorage(false));

    await expect(secrets.setKey('proveedor', SAMPLE_KEY)).rejects.toThrowError(
      ERR_ENCRYPTION_UNAVAILABLE,
    );
    await expect(secrets.setKey('proveedor', SAMPLE_KEY)).rejects.toBeInstanceOf(SecretsError);
    // No se guardó nada: nunca se cae a texto plano.
    expect(await secrets.hasKey('proveedor')).toBe(false);
  });

  it('rechaza el backend basic_text de Linux aunque isEncryptionAvailable diga true', async () => {
    const { db } = fileDb();
    const basicText: SafeStorageLike = {
      ...fakeSafeStorage(),
      getSelectedStorageBackend: () => 'basic_text',
    };
    const secrets = createSecretsService(db, basicText);

    await expect(secrets.setKey('proveedor', SAMPLE_KEY)).rejects.toThrowError(
      ERR_ENCRYPTION_UNAVAILABLE,
    );
    await expect(secrets.setKey('proveedor', SAMPLE_KEY)).rejects.toBeInstanceOf(SecretsError);
    // No se guardó nada: basic_text es en la práctica texto plano.
    expect(await secrets.hasKey('proveedor')).toBe(false);
  });

  it('también rechaza basic_text al leer una clave ya guardada (solo main)', async () => {
    const { db } = fileDb();
    const keyringBackend: SafeStorageLike = {
      ...fakeSafeStorage(),
      getSelectedStorageBackend: () => 'kwallet6',
    };
    await createSecretsService(db, keyringBackend).setKey('proveedor', SAMPLE_KEY);

    // El llavero desaparece y Electron cae a basic_text: la lectura se rechaza.
    const basicText: SafeStorageLike = {
      ...fakeSafeStorage(),
      getSelectedStorageBackend: () => 'basic_text',
    };
    const degraded = createSecretsService(db, basicText);
    await expect(degraded.getKey('proveedor')).rejects.toThrowError(ERR_ENCRYPTION_UNAVAILABLE);
    // hasKey y deleteKey siguen disponibles para poder limpiar la clave.
    expect(await degraded.hasKey('proveedor')).toBe(true);
    await degraded.deleteKey('proveedor');
    expect(await degraded.hasKey('proveedor')).toBe(false);
  });

  it('acepta un backend de llavero real en Linux (gnome_libsecret, kwallet…)', async () => {
    const { db } = fileDb();
    const keyringBackend: SafeStorageLike = {
      ...fakeSafeStorage(),
      getSelectedStorageBackend: () => 'gnome_libsecret',
    };
    const secrets = createSecretsService(db, keyringBackend);

    await secrets.setKey('proveedor', SAMPLE_KEY);
    expect(await secrets.getKey('proveedor')).toBe(SAMPLE_KEY);
  });

  it('falla con un error claro si el almacén no está disponible', async () => {
    const secrets = createSecretsService(null, fakeSafeStorage());

    await expect(secrets.setKey('p', SAMPLE_KEY)).rejects.toThrowError(ERR_STORAGE_UNAVAILABLE);
    await expect(secrets.hasKey('p')).rejects.toThrowError(ERR_STORAGE_UNAVAILABLE);
    await expect(secrets.deleteKey('p')).rejects.toThrowError(ERR_STORAGE_UNAVAILABLE);
    await expect(secrets.getKey('p')).rejects.toThrowError(ERR_STORAGE_UNAVAILABLE);
  });

  it('recorta espacios de los bordes y rechaza controles o espacios dentro de la clave', async () => {
    const { db } = fileDb();
    const secrets = createSecretsService(db, fakeSafeStorage());

    // El copiado con espacios o un salto al final se guarda limpio.
    await secrets.setKey('proveedor', `  ${SAMPLE_KEY}\n`);
    expect(await secrets.getKey('proveedor')).toBe(SAMPLE_KEY);

    // Un control dentro (p. ej. «clave\rparte») rompería la cabecera
    // HTTP y su mensaje de error la citaría: no se guarda así.
    await expect(
      secrets.setKey('proveedor', 'tk9f8e7d6c5b4a3SECRETO\rtiingo'),
    ).rejects.toBeInstanceOf(SecretsError);
    await expect(secrets.setKey('proveedor', 'parte1 parte2')).rejects.toBeInstanceOf(SecretsError);
    // Nada se guardó: la clave limpia anterior sigue intacta.
    expect(await secrets.getKey('proveedor')).toBe(SAMPLE_KEY);
  });

  it('marca como no válida una clave guardada con caracteres de control (anterior a setKey)', async () => {
    const { db } = fileDb();
    const crypto = fakeSafeStorage();
    const secrets = createSecretsService(db, crypto);
    // Una clave guardada antes de la validación de setKey (fila escrita a
    // mano, como la del fallo R1) puede llevar un control dentro: getKey
    // la marca como no válida en vez de entregarla a una cabecera HTTP.
    const dirty = 'tk-SECRETO\rtiingo';
    const ciphertext = crypto.encryptString(dirty).toString('base64');
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO secrets (provider, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('tiingo', ciphertext, now, now);

    const error = await secrets.getKey('tiingo').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidStoredKeyError);
    expect((error as Error).message).toContain('vuelve a pegarla');
    // Ni el mensaje ni el tipo de error llevan la clave.
    expect((error as Error).message).not.toContain('SECRETO');
  });

  it.each([['clave '], [' clave'], ['\tclave\n']])(
    'una clave guardada sin recortar (%j) se devuelve recortada, como en main',
    async (stored) => {
      const { db } = fileDb();
      const crypto = fakeSafeStorage();
      const secrets = createSecretsService(db, crypto);
      // Las claves guardadas antes de esta rama iban a la fila sin recortar
      // (setKey no recortaba) y funcionaban, porque Headers quita los
      // espacios de los extremos. getKey aplica el mismo criterio que
      // setKey: recorta y devuelve la clave limpia.
      const ciphertext = crypto.encryptString(stored).toString('base64');
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO secrets (provider, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run('tiingo', ciphertext, now, now);

      expect(await secrets.getKey('tiingo')).toBe('clave');
    },
  );

  it.each([['cla\rve'], ['cla ve']])(
    'una clave guardada con un control o un espacio dentro (%j) sigue marcada como no válida',
    async (stored) => {
      const { db } = fileDb();
      const crypto = fakeSafeStorage();
      const secrets = createSecretsService(db, crypto);
      const ciphertext = crypto.encryptString(stored).toString('base64');
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO secrets (provider, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run('tiingo', ciphertext, now, now);

      await expect(secrets.getKey('tiingo')).rejects.toBeInstanceOf(InvalidStoredKeyError);
    },
  );

  it('informa si el dato cifrado está corrupto al leerlo (solo main)', async () => {
    const { db } = fileDb();
    const corruptCrypto: SafeStorageLike = {
      ...fakeSafeStorage(),
      decryptString: () => {
        throw new Error('lla vero no reconoce el dato');
      },
    };
    const secrets = createSecretsService(db, corruptCrypto);
    await secrets.setKey('proveedor', SAMPLE_KEY);

    await expect(secrets.getKey('proveedor')).rejects.toThrowError(SecretsError);
  });
});

describe('registro IPC', () => {
  it('emite secrets:changed con solo el proveedor al guardar y al borrar', async () => {
    electron.handlers.clear();
    const { db } = fileDb();
    const sent: { channel: string; payload: unknown }[] = [];
    const ctx = {
      services: { storage: { getDb: () => db } },
      broadcast: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    };
    const service = registerSecrets(ctx as never);

    const setKey = electron.handlers.get(IPC_CHANNELS.secrets.setKey)!;
    const deleteKey = electron.handlers.get(IPC_CHANNELS.secrets.deleteKey)!;
    await setKey(null, 'fred', SAMPLE_KEY);
    await deleteKey(null, 'fred');

    expect(sent).toEqual([
      { channel: IPC_CHANNELS.secrets.changed, payload: { provider: 'fred' } },
      { channel: IPC_CHANNELS.secrets.changed, payload: { provider: 'fred' } },
    ]);
    // El evento nunca lleva la clave.
    expect(JSON.stringify(sent)).not.toContain(SAMPLE_KEY);
    expect(await service.hasKey('fred')).toBe(false);
  });
});
