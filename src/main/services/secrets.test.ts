import type Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db/database';
import {
  createSecretsService,
  ERR_ENCRYPTION_UNAVAILABLE,
  ERR_STORAGE_UNAVAILABLE,
  SecretsError,
  type SafeStorageLike,
} from './secrets';

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
