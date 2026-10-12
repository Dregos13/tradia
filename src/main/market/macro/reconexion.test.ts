/**
 * Regresión del fallo pendiente «Al volver la red no reintenta Tiingo ni
 * FRED» (docs/qa/cierre-fallos-fase-6-7.md, fila 1), parte FRED: el
 * registro del servicio macro observa `connectivity:changed` a través de
 * `ctx.broadcast` y, tras un corte, pide las series en cuanto vuelve la
 * red, sin esperar a la siguiente cita programada.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../../../shared/ipc';
import { MIGRATIONS } from '../../db/migrations';
import { migrate } from '../../db/migrator';
import type { ServiceContext } from '../../services';
import type { StorageService } from '../../services/storage';
import { createSimulatedMacroProvider } from './simulated';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: () => undefined },
  powerMonitor: { on: () => undefined, removeListener: () => undefined },
}));

import { registerMacro } from './index';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
});

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function setup() {
  let status: 'online' | 'offline' = 'online';
  const provider = createSimulatedMacroProvider({ seed: 'reconexion', genesis: '2026-09-01' });
  const getObservations = vi.spyOn(provider, 'getObservations');
  const ctx = {
    broadcast: vi.fn(),
    services: {
      storage: { getDb: () => db } as unknown as StorageService,
      connectivity: { getState: () => ({ status }) },
    },
  } as unknown as ServiceContext;
  registerMacro(ctx, { provider, autoStart: false });
  const emitConnectivity = (next: 'online' | 'offline') => {
    status = next;
    ctx.broadcast(IPC_CHANNELS.connectivity.changed, { status: next });
  };
  return { getObservations, emitConnectivity };
}

describe('FRED al volver la red', () => {
  it('tras un corte, la vuelta de la red lanza la puesta al día de las series', async () => {
    const { getObservations, emitConnectivity } = setup();

    emitConnectivity('offline');
    await flush();
    expect(getObservations).not.toHaveBeenCalled();

    emitConnectivity('online');
    await flush();
    expect(getObservations).toHaveBeenCalled();
  });

  it('un «online» sin corte previo no relanza descargas en cada sondeo', async () => {
    const { getObservations, emitConnectivity } = setup();

    emitConnectivity('online');
    emitConnectivity('online');
    await flush();
    expect(getObservations).not.toHaveBeenCalled();
  });
});
