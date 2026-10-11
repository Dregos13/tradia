/**
 * Auditoría adversarial de «Probar conexión» (`providers:test-connection`)
 * — auditoría de cierre de la continuación de la fase 6-7.
 *
 * La prueba usa la clave guardada del usuario contra Tiingo (cabecera
 * `Authorization`) y FRED (parámetro `api_key` en la URL). Se ataca con el
 * handler IPC real en modo producción (app empaquetada, sondeos reales) y
 * un `fetch` falso que hace lo peor que puede hacer un proveedor o la red:
 * devolver la clave dentro del cuerpo del error, en un 200 inesperado o
 * en el mensaje de un fallo de transporte. Garantía atacada: la clave
 * nunca aparece en el resultado devuelto al renderer, en `data_status`
 * (que se emite y se pinta), en los eventos emitidos ni en los registros.
 *
 * Los hallazgos nuevos están en
 * docs/qa/auditoria-continuacion-fase-6-7.md, llevan «HALLAZGO Cn» en el
 * nombre y se declaran como fallo esperado (`fails` de vitest): pasan
 * mientras el bug exista y se ponen en rojo al corregirlo; en ese momento
 * hay que quitarles el `.fails`.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { IPC_CHANNELS, type DataProviderId, type ProviderTestResult } from '../../../shared/ipc';
import { openDatabase } from '../../db/database';
import { createTiingoProvider } from '../../market/providers/tiingo';
import { createMarketRepository } from '../../market/repository';
import type { ServiceContext } from '../../services';
import { registerProviders } from '../index';

const KEYS: Record<DataProviderId, string> = {
  tiingo: 'tk9f8e7d6c5b4a3SECRETOtiingo',
  fred: 'fe0123456789abcdefSECRETOfred00',
};
const NOW = Date.parse('2026-10-09T12:00:00.000Z');

let db: Database.Database;
let sent: { channel: string; payload: unknown }[];
let logged: string[];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Lo que el proveedor o la red devuelven en cada escenario (con la clave dentro). */
type Scenario = {
  label: string;
  respond: (provider: DataProviderId, key: string) => Response | Promise<Response>;
};

const SCENARIOS: Scenario[] = [
  {
    label: '200 con datos',
    respond: (provider) =>
      provider === 'tiingo'
        ? json([
            {
              date: '2026-10-08T00:00:00.000Z',
              open: 1,
              high: 1,
              low: 1,
              close: 1,
              volume: 1,
              adjClose: 1,
            },
          ])
        : json({ observations: [{ date: '2026-10-08', value: '16.2' }] }),
  },
  {
    label: '401 que repite la clave',
    respond: (_p, key) => json({ detail: `Invalid token ${key}` }, 401),
  },
  {
    label: '403 que repite la clave',
    respond: (_p, key) => json({ detail: `Forbidden ${key}` }, 403),
  },
  {
    label: '400 de FRED con la clave en error_message',
    respond: (_p, key) =>
      json(
        {
          error_code: 400,
          error_message: `Bad Request.  The value for variable api_key ${key} is not registered.`,
        },
        400,
      ),
  },
  {
    label: '429 que repite la clave',
    respond: (_p, key) =>
      json({ detail: `quota exceeded for ${key}` }, 429, { 'retry-after': '60' }),
  },
  {
    label: '500 que repite la clave',
    respond: (_p, key) => new Response(`boom ${key}`, { status: 500 }),
  },
  {
    label: '404 que repite la clave',
    respond: (_p, key) => new Response(`no ${key}`, { status: 404 }),
  },
  { label: '200 que no es JSON', respond: (_p, key) => new Response(`<html>${key}</html>`) },
  {
    label: 'fallo de transporte con la URL (y la clave de FRED) en el mensaje',
    respond: () => {
      // undici incluye la URL en «Failed to parse URL from …»; FRED la
      // lleva con ?api_key=…
      throw new TypeError(
        `Failed to parse URL from https://api.stlouisfed.org/fred/series/observations?api_key=${KEYS.fred}`,
      );
    },
  },
];

const makeCtx = (keys: Partial<Record<DataProviderId, string>>): ServiceContext =>
  ({
    broadcast: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    services: {
      storage: { getDb: () => db },
      secrets: {
        setKey: async () => undefined,
        hasKey: async (provider: string) => provider in keys,
        deleteKey: async () => undefined,
        getKey: async (provider: string) => keys[provider as DataProviderId] ?? null,
      },
      connectivity: { getState: () => ({ status: 'online' }) },
    },
  }) as unknown as ServiceContext;

const testConnection = async (provider: DataProviderId): Promise<ProviderTestResult> => {
  const handler = electron.handlers.get(IPC_CHANNELS.providers.testConnection);
  if (handler === undefined) throw new Error('providers:test-connection no registrado');
  return (await handler({}, { provider })) as ProviderTestResult;
};

/** Todo lo observable fuera del proceso: resultado, data_status, eventos y registros. */
const everythingObservable = (results: ProviderTestResult[]): string =>
  JSON.stringify({
    results,
    dataStatus: createMarketRepository(db).listDataStatus(),
    sent,
    logged,
  });

beforeEach(() => {
  db = openDatabase(':memory:');
  sent = [];
  logged = [];
  electron.isPackaged = true;
  electron.handlers.clear();
  vi.stubEnv('TRADIA_E2E', '');
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(
        args
          .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg)))
          .join(' '),
      );
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  db.close();
});

describe('auditoría de cierre · la clave nunca sale de «Probar conexión»', () => {
  it.each(SCENARIOS)(
    '$label: ni el resultado, ni data_status, ni los eventos ni los registros llevan la clave',
    async ({ respond }) => {
      const results: ProviderTestResult[] = [];
      for (const provider of ['tiingo', 'fred'] as const) {
        electron.handlers.clear();
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => respond(provider, KEYS[provider])),
        );
        registerProviders(makeCtx(KEYS), { now: () => NOW });
        results.push(await testConnection(provider));
      }
      const observable = everythingObservable(results);
      expect(observable).not.toContain(KEYS.tiingo);
      expect(observable).not.toContain(KEYS.fred);
      // Y cada resultado es uno de los seis estados del contrato.
      for (const result of results) {
        expect(['ok', 'sin-clave', 'clave-rechazada', 'cuota', 'sin-red', 'error']).toContain(
          result.status,
        );
      }
    },
  );

  it('una clave con caracteres que URLSearchParams codifica tampoco se cuela en FRED', async () => {
    const key = 'fred key+con/simbolos=SECRETO';
    const encoded = new URLSearchParams({ k: key }).toString().slice(2);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => new Response(`echo ${url} ${key} ${encoded}`, { status: 500 })),
    );
    registerProviders(makeCtx({ fred: key }), { now: () => NOW });
    const result = await testConnection('fred');
    const observable = everythingObservable([result]);
    expect(observable).not.toContain(key);
    expect(observable).not.toContain('SECRETO');
  });

  it('sin clave guardada no se llama a la red y el estado es «sin-clave»', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    registerProviders(makeCtx({}), { now: () => NOW });
    for (const provider of ['tiingo', 'fred'] as const) {
      const result = await testConnection(provider);
      expect(result.status).toBe('sin-clave');
      expect(result.latencyMs).toBeNull();
    }
    expect(network).not.toHaveBeenCalled();
  });

  it.fails(
    'HALLAZGO C7 · un 200 de Tiingo con «detail» que repite la clave no la devuelve en el resultado ni en data_status',
    async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          json({ detail: `Error: token ${KEYS.tiingo} is not valid for this endpoint` }),
        ),
      );
      registerProviders(makeCtx(KEYS), { now: () => NOW });
      const result = await testConnection('tiingo');
      expect(everythingObservable([result])).not.toContain(KEYS.tiingo);
    },
  );

  it.fails(
    'HALLAZGO C8 · un fallo de transporte de Tiingo que cita la cabecera no lleva la clave en el error',
    async () => {
      // Lo que lanza el fetch de Node (undici) cuando la clave guardada
      // tiene un carácter de control (p. ej. un retorno de carro pegado
      // en medio): el mensaje cita la cabecera entera.
      const key = 'tk9f8e7d6c5b4a3SECRETO\rtiingo';
      const tiingo = createTiingoProvider({
        fetch: (async () => {
          throw new TypeError(
            `Headers.append: "Token ${key.replace('\r', '')}" is an invalid header value.`,
          );
        }) as unknown as typeof fetch,
        getApiKey: async () => key,
        now: () => NOW,
      });
      const outcome = await tiingo.getQuote('SPY').then(
        () => 'resuelto',
        (error: unknown) => String((error as Error).message),
      );
      // Ese mensaje es el `reason` que la ingesta guarda en data_status y
      // registra con logger.warn.
      expect(outcome).not.toContain('SECRETO');
    },
  );
});
