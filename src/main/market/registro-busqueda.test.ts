import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../../shared/ipc';
import type { ServiceContext } from '../services';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: true },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      // Como Electron: registrar dos veces el mismo canal es un error.
      if (electron.handlers.has(channel)) throw new Error(`duplicado: ${channel}`);
      electron.handlers.set(channel, handler);
    },
  },
  powerMonitor: { on: () => undefined, removeListener: () => undefined },
}));

import { registerMarket } from './ingestion';

function makeCtx(): ServiceContext {
  return { services: {}, broadcast: () => undefined } as unknown as ServiceContext;
}

describe('registerMarket · cableado del buscador', () => {
  beforeEach(() => {
    electron.handlers.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registra market:search y responde mediante el servicio de búsqueda', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = registerMarket(makeCtx());
    try {
      const handler = electron.handlers.get(IPC_CHANNELS.market.search);
      expect(handler).toBeTypeOf('function');
      const result = handler?.(null, 'EUR/USD') as { matches: Array<{ ticker: string }> };
      expect(result.matches.some((m) => m.ticker === 'EURUSD')).toBe(true);
    } finally {
      service.stop();
    }
  });
});
