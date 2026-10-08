import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../../../shared/ipc';
import { MIGRATIONS } from '../../db/migrations';
import { migrate } from '../../db/migrator';
import type { StorageService } from '../../services/storage';
import { createSimulatedMacroProvider } from './simulated';

const electron = vi.hoisted(() => ({
  isPackaged: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: electron.isPackaged },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
}));

import { registerMacro } from './index';

let db: Database.Database;

beforeEach(() => {
  electron.handlers.clear();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
});

const ctx = () => ({
  broadcast: vi.fn(),
  services: {
    storage: { getDb: () => db } as unknown as StorageService,
  },
});

describe('registro del servicio macro', () => {
  it('registra el handler macro:get-series y sirve los snapshots', async () => {
    const provider = createSimulatedMacroProvider({ seed: 'ipc', genesis: '2026-09-01' });
    const service = registerMacro(ctx(), { provider, autoStart: false });

    const handler = electron.handlers.get(IPC_CHANNELS.macro.getSeries)!;
    expect(handler).toBeDefined();

    await service.refreshAll();
    const snapshots = handler(null, undefined) as { id: string }[];
    expect(snapshots.map((s) => s.id)).toEqual([
      'CPIAUCSL',
      'DFF',
      'DGS10',
      'DGS2',
      'T10Y2Y',
      'VIXCLS',
    ]);
  });

  it('valida la query y rechaza fechas imposibles', async () => {
    const provider = createSimulatedMacroProvider({ seed: 'ipc', genesis: '2026-09-01' });
    registerMacro(ctx(), { provider, autoStart: false });
    const handler = electron.handlers.get(IPC_CHANNELS.macro.getSeries)!;

    expect(() => handler(null, { desde: '2026-13-45' })).toThrowError(/entrada inválida/);
    expect(() => handler(null, { desde: 'ayer' })).toThrowError(/entrada inválida/);
    expect(() => handler(null, { otra: 1 })).toThrowError(/entrada inválida/);
    expect(() => handler(null, { desde: '2026-10-01' })).not.toThrow();
    expect(() => handler(null)).not.toThrow();
  });

  it('sin base de datos el handler devuelve lista vacía', () => {
    const provider = createSimulatedMacroProvider({ seed: 'ipc' });
    registerMacro({ broadcast: vi.fn(), services: {} }, { provider, autoStart: false });
    const handler = electron.handlers.get(IPC_CHANNELS.macro.getSeries)!;
    expect(handler(null, undefined)).toEqual([]);
  });
});
