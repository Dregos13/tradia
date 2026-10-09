import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS, IpcValidationError } from '../../shared/ipc';
import type { ServiceContext } from '../services';
import { registerStorage, type StorageService } from '../services/storage';
import { registerBackup, type BackupService } from './index';

// electron aporta app (rutas, relaunch/exit), ipcMain (mapa de handlers) y
// shell.openPath (apertura de la carpeta de registros) al registro real.
const electron = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  opened: [] as string[],
  openPathError: '',
  relaunches: 0,
  exits: [] as number[],
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => electron.userData,
    relaunch: () => {
      electron.relaunches += 1;
    },
    exit: (code: number) => {
      electron.exits.push(code);
    },
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
  shell: {
    openPath: async (path: string) => {
      electron.opened.push(path);
      return electron.openPathError;
    },
  },
}));

const dirs: string[] = [];
const storages: StorageService[] = [];
const services: BackupService[] = [];

function setup(): { userData: string; ctx: ServiceContext } {
  const userData = mkdtempSync(join(tmpdir(), 'tradia-backup-ipc-'));
  dirs.push(userData);
  electron.userData = userData;
  const ctx: ServiceContext = { broadcast: () => {}, services: {} };
  const storage = registerStorage(ctx, { dbFile: join(userData, 'tradia.db') });
  storages.push(storage);
  ctx.services.storage = storage;
  return { userData, ctx };
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel);
  expect(handler, `handler no registrado: ${channel}`).toBeDefined();
  // Los handlers lanzan IpcValidationError de forma síncrona: se envuelve
  // para que llegue como rechazo, igual que por IPC real.
  return Promise.resolve().then(() => handler!({}, ...args));
}

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const storage of storages.splice(0)) storage.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  electron.handlers.clear();
  electron.opened.length = 0;
  electron.openPathError = '';
  electron.relaunches = 0;
  electron.exits.length = 0;
});

describe('IPC de copias y registros', () => {
  it('registra backup:list/create/restore y logs:open-folder', async () => {
    const { ctx } = setup();
    services.push(registerBackup(ctx));

    for (const channel of [
      IPC_CHANNELS.backup.list,
      IPC_CHANNELS.backup.create,
      IPC_CHANNELS.backup.restore,
      IPC_CHANNELS.logs.openFolder,
    ]) {
      expect(electron.handlers.has(channel)).toBe(true);
    }

    const created = (await invoke(IPC_CHANNELS.backup.create)) as { fileName: string };
    expect(created.fileName).toMatch(/^tradia-.*\.db$/);

    const list = (await invoke(IPC_CHANNELS.backup.list)) as { fileName: string }[];
    expect(list.some((b) => b.fileName === created.fileName)).toBe(true);
  });

  it('backup:restore valida la petición y restaura + reinicia', async () => {
    const { userData, ctx } = setup();
    services.push(registerBackup(ctx));

    await expect(invoke(IPC_CHANNELS.backup.restore, { fileName: 'x.db' })).rejects.toBeInstanceOf(
      IpcValidationError,
    );
    await expect(
      invoke(IPC_CHANNELS.backup.restore, { fileName: '../etc/passwd.db', confirm: true }),
    ).rejects.toBeInstanceOf(IpcValidationError);

    const created = (await invoke(IPC_CHANNELS.backup.create)) as { fileName: string };
    const result = (await invoke(IPC_CHANNELS.backup.restore, {
      fileName: created.fileName,
      confirm: true,
    })) as { accepted: boolean };

    expect(result.accepted).toBe(true);
    expect(electron.relaunches).toBe(1);
    expect(electron.exits).toEqual([0]);
    // La copia previa al estado actual quedó guardada.
    expect(
      readdirSync(join(userData, 'backups')).some((f) => f.startsWith('tradia-pre-restauracion-')),
    ).toBe(true);
  });

  it('logs:open-folder crea la carpeta, la abre y devuelve la ruta', async () => {
    const { userData, ctx } = setup();
    services.push(registerBackup(ctx));

    const result = (await invoke(IPC_CHANNELS.logs.openFolder)) as {
      ok: boolean;
      path: string;
    };
    const expected = join(userData, 'logs');
    expect(result).toEqual({ ok: true, path: expected });
    expect(electron.opened).toEqual([expected]);
    expect(existsSync(expected)).toBe(true);

    // Si el sistema no puede abrirla, ok=false pero la ruta vuelve para «Copiar ruta».
    electron.openPathError = 'permiso denegado';
    const failed = (await invoke(IPC_CHANNELS.logs.openFolder)) as { ok: boolean; path: string };
    expect(failed).toEqual({ ok: false, path: expected });
  });
});
