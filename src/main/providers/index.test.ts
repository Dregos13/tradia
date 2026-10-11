import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS, dataStatusKey, type ProviderTestResult } from '../../shared/ipc';
import { openDatabase } from '../db/database';
import { createMarketRepository } from '../market/repository';
import type { ServiceContext } from '../services';
import { registerProviders } from './index';
import aaplLatest from '../market/providers/__fixtures__/aapl-latest.json';
import vixclsObservations from '../market/macro/__fixtures__/vixcls-observations.json';

// electron solo aporta app.isPackaged e ipcMain.handle: mismo patrón que las
// demás pruebas de servicios de main (broker/index.test.ts).
const electron = vi.hoisted(() => ({
  isPackaged: true,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged;
    },
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
}));

const TIINGO_KEY = 'tk-SECRETO-de-prueba-12345';
const FRED_KEY = 'abcdef0123456789abcdef0123456789';

let db: Database.Database;
let keys: Map<string, string>;
let sent: Array<{ channel: string; payload: unknown }>;
let online: boolean;
let fetchCalls: string[];

const secretsStub = () => ({
  setKey: async (provider: string, apiKey: string) => {
    keys.set(provider, apiKey);
  },
  hasKey: async (provider: string) => keys.has(provider),
  deleteKey: async (provider: string) => {
    keys.delete(provider);
  },
  getKey: async (provider: string) => keys.get(provider) ?? null,
});

const makeCtx = (): ServiceContext => {
  sent = [];
  return {
    broadcast: (channel, payload) => {
      sent.push({ channel, payload });
    },
    services: {
      storage: { getDb: () => db } as never,
      secrets: secretsStub() as never,
      connectivity: {
        getState: () => ({ status: online ? 'online' : 'offline' }),
      } as never,
    },
  };
};

/** Instante fijo de las pruebas: 2026-10-09 (viernes), mediodía UTC. */
const NOW = Date.parse('2026-10-09T12:00:00.000Z');

/** Registra el servicio en modo producción (isPackaged) o E2E según el test. */
const register = (ctx: ServiceContext) => {
  electron.handlers.clear();
  return registerProviders(ctx, { now: () => NOW });
};

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = electron.handlers.get(channel);
  expect(handler, `handler ${channel} registrado`).toBeDefined();
  return handler!(/* event */ {}, ...args);
};

const dataStatusEntries = () =>
  sent.filter((s) => s.channel === IPC_CHANNELS.dataStatus.changed).map((s) => s.payload);

beforeEach(() => {
  db = openDatabase(':memory:');
  keys = new Map();
  sent = [];
  online = true;
  fetchCalls = [];
  electron.isPackaged = true;
  delete process.env.TRADIA_E2E;
});

afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  delete process.env.TRADIA_E2E;
});

describe('registerProviders — producción', () => {
  it('valida la petición y rechaza proveedores desconocidos', async () => {
    register(makeCtx());
    await expect(invoke(IPC_CHANNELS.providers.testConnection, { provider: 'x' })).rejects.toThrow(
      /providers:test-connection/,
    );
    await expect(invoke(IPC_CHANNELS.providers.testConnection, null)).rejects.toThrow(
      /providers:test-connection/,
    );
    await expect(
      invoke(IPC_CHANNELS.providers.testConnection, { provider: 'tiingo', apiKey: 'colada' }),
    ).rejects.toThrow(/providers:test-connection/);
  });

  it('sin clave: «sin-clave», sin llamada a la red y sin datos simulados servidos', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = makeCtx();
    register(ctx);

    for (const provider of ['tiingo', 'fred'] as const) {
      const result = (await invoke(IPC_CHANNELS.providers.testConnection, {
        provider,
      })) as ProviderTestResult;

      expect(result.status).toBe('sin-clave');
      expect(result.message).toBe('Sin clave guardada.');
      expect(result.latestDataDate).toBeNull();
      expect(result.latencyMs).toBeNull();
      expect(JSON.stringify(result)).not.toContain('SECRETO');
    }
    expect(fetchSpy).not.toHaveBeenCalled();

    // Producción sin clave = «sin configurar»: ningún estado provider:*
    // rojo y ninguna vela u observación servida (los adaptadores simulados
    // solo existen en modo E2E, nunca con la app empaquetada).
    const repo = createMarketRepository(db);
    expect(repo.getDataStatus(dataStatusKey.provider('tiingo'))).toBeNull();
    expect(repo.getDataStatus(dataStatusKey.provider('fred'))).toBeNull();
    expect(repo.lastBarDate('SPY')).toBeNull();
    expect(repo.lastMacroObservationDate('VIXCLS')).toBeNull();
    expect(dataStatusEntries()).toHaveLength(0);
  });

  it('ok con clave guardada: «fiable» en provider:<id> emitido por data-status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        fetchCalls.push(String(input));
        return new Response(JSON.stringify(aaplLatest), { status: 200 });
      }),
    );
    keys.set('tiingo', TIINGO_KEY);
    register(makeCtx());

    const result = (await invoke(IPC_CHANNELS.providers.testConnection, {
      provider: 'tiingo',
    })) as ProviderTestResult;

    expect(result.status).toBe('ok');
    expect(result.latestDataDate).toBe('2026-10-07');
    expect(fetchCalls).toHaveLength(1);

    const repo = createMarketRepository(db);
    const entry = repo.getDataStatus(dataStatusKey.provider('tiingo'));
    expect(entry?.state).toBe('fiable');
    expect(entry?.consecutiveFailures).toBe(0);
    expect(entry?.lastOkAt).toBe(result.checkedAt);
    expect(dataStatusEntries()).toContainEqual(entry);
  });

  it('ok en FRED: la clave va en api_key y no sale en el resultado ni en el estado', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        fetchCalls.push(String(input));
        return new Response(JSON.stringify(vixclsObservations), { status: 200 });
      }),
    );
    keys.set('fred', FRED_KEY);
    register(makeCtx());

    const result = (await invoke(IPC_CHANNELS.providers.testConnection, {
      provider: 'fred',
    })) as ProviderTestResult;

    expect(result.status).toBe('ok');
    expect(result.latestDataDate).toBe('2026-10-08');
    expect(fetchCalls[0]).toContain(`api_key=${FRED_KEY}`);
    expect(JSON.stringify(result)).not.toContain(FRED_KEY);

    const repo = createMarketRepository(db);
    const entry = repo.getDataStatus(dataStatusKey.provider('fred'));
    expect(entry?.state).toBe('fiable');
    expect(JSON.stringify(entry)).not.toContain(FRED_KEY);
  });

  it('clave rechazada: marca provider:<id> «no-fiable» sin copiar la clave', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: 'Invalid token' }), { status: 401 })),
    );
    keys.set('tiingo', TIINGO_KEY);
    register(makeCtx());

    const result = (await invoke(IPC_CHANNELS.providers.testConnection, {
      provider: 'tiingo',
    })) as ProviderTestResult;

    expect(result.status).toBe('clave-rechazada');
    const repo = createMarketRepository(db);
    const entry = repo.getDataStatus(dataStatusKey.provider('tiingo'));
    expect(entry?.state).toBe('no-fiable');
    expect(entry?.consecutiveFailures).toBe(1);
    expect(entry?.reason).not.toContain(TIINGO_KEY);
  });

  it('cuota y errores transitorios acumulan fallos: a los 3, «no-fiable»', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: 'rate' }), { status: 429 })),
    );
    keys.set('tiingo', TIINGO_KEY);
    register(makeCtx());
    const repo = createMarketRepository(db);
    const key = dataStatusKey.provider('tiingo');

    for (const attempt of [1, 2, 3]) {
      const result = (await invoke(IPC_CHANNELS.providers.testConnection, {
        provider: 'tiingo',
      })) as ProviderTestResult;
      expect(result.status).toBe('cuota');
      const entry = repo.getDataStatus(key);
      expect(entry?.consecutiveFailures).toBe(attempt);
      expect(entry?.state).toBe(attempt < 3 ? 'desactualizado' : 'no-fiable');
    }
  });

  it('sin red local: «sin-red» sin sondeo y estado desactualizado', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    online = false;
    keys.set('tiingo', TIINGO_KEY);
    register(makeCtx());

    const result = (await invoke(IPC_CHANNELS.providers.testConnection, {
      provider: 'tiingo',
    })) as ProviderTestResult;

    expect(result.status).toBe('sin-red');
    expect(fetchSpy).not.toHaveBeenCalled();
    const repo = createMarketRepository(db);
    expect(repo.getDataStatus(dataStatusKey.provider('tiingo'))?.state).toBe('desactualizado');
  });

  it('un ok posterior levanta el estado malo y pone el contador a cero', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fail
          ? new Response('{}', { status: 500 })
          : new Response(JSON.stringify(aaplLatest), { status: 200 }),
      ),
    );
    keys.set('tiingo', TIINGO_KEY);
    register(makeCtx());
    const repo = createMarketRepository(db);
    const key = dataStatusKey.provider('tiingo');

    await invoke(IPC_CHANNELS.providers.testConnection, { provider: 'tiingo' });
    expect(repo.getDataStatus(key)?.state).toBe('desactualizado');

    fail = false;
    const ok = (await invoke(IPC_CHANNELS.providers.testConnection, {
      provider: 'tiingo',
    })) as ProviderTestResult;
    expect(ok.status).toBe('ok');
    const entry = repo.getDataStatus(key);
    expect(entry?.state).toBe('fiable');
    expect(entry?.consecutiveFailures).toBe(0);
  });

  it('no registra el gancho E2E en producción', () => {
    register(makeCtx());
    expect(electron.handlers.has(IPC_CHANNELS.providers.simulateTest)).toBe(false);
  });
});

describe('registerProviders — modo E2E', () => {
  beforeEach(() => {
    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
  });

  it('sin armar usa los proveedores simulados y devuelve ok con fecha', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    register(makeCtx());

    const result = (await invoke(IPC_CHANNELS.providers.testConnection, {
      provider: 'tiingo',
    })) as ProviderTestResult;

    expect(result.status).toBe('ok');
    expect(result.latestDataDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // En E2E el sondeo es simulado: nunca sale a la red real.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('el gancho fuerza cada estado y se consume una vez', async () => {
    register(makeCtx());
    const repo = createMarketRepository(db);

    const armed = (await invoke(IPC_CHANNELS.providers.simulateTest, {
      provider: 'fred',
      status: 'clave-rechazada',
    })) as { provider: string; armed: string };
    expect(armed.armed).toBe('clave-rechazada');

    const forced = (await invoke(IPC_CHANNELS.providers.testConnection, {
      provider: 'fred',
    })) as ProviderTestResult;
    expect(forced.status).toBe('clave-rechazada');
    expect(forced.latestDataDate).toBeNull();
    expect(repo.getDataStatus(dataStatusKey.provider('fred'))?.state).toBe('no-fiable');

    // Consume-once: la siguiente vuelve al sondeo simulado → ok.
    const next = (await invoke(IPC_CHANNELS.providers.testConnection, {
      provider: 'fred',
    })) as ProviderTestResult;
    expect(next.status).toBe('ok');
    expect(repo.getDataStatus(dataStatusKey.provider('fred'))?.state).toBe('fiable');
  });

  it('el gancho valida provider y estado del contrato', async () => {
    register(makeCtx());
    await expect(
      invoke(IPC_CHANNELS.providers.simulateTest, { provider: 'tiingo', status: 'inventado' }),
    ).rejects.toThrow(/providers:simulate-test/);
    await expect(
      invoke(IPC_CHANNELS.providers.simulateTest, { provider: 'alpaca', status: 'ok' }),
    ).rejects.toThrow(/providers:simulate-test/);
  });
});
