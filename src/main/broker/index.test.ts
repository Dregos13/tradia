import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BROKER_SECRET_KEYS, IPC_CHANNELS } from '../../shared/ipc';
import type { RiskDecision } from '../../shared/risk';
import type { Signal } from '../../shared/signals';
import { openDatabase } from '../db/database';
import { createJournalRepository } from '../journal/repository';
import { createJournalService, type JournalService } from '../journal';
import type { ServiceContext } from '../services';
import { createSignalsRepository, type NewSignal } from '../signals/repository';
import {
  ERR_BROKER_LIVE_KEYS,
  ERR_BROKER_NO_ACCOUNT,
  ERR_BROKER_NO_KEYS,
  registerBroker,
  type BrokerService,
} from './index';
import { createBrokerRepository, type BrokerRepository } from './repository';

// electron solo aporta app/ipcMain: mismo patrón que las demás pruebas
// de servicios de main (settings-ipc.test.ts, routine/index.test.ts).
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

const SECRET = 'secret-de-prueba-01';
const PAPER_KEY = 'PKTESTKEY01';
const LIVE_KEY = 'AKTESTKEY01';

let db: Database.Database;
let repo: BrokerRepository;
let signalsRepo: ReturnType<typeof createSignalsRepository>;
let journal: JournalService;
let keys: Map<string, string>;
let sent: Array<{ channel: string; payload: unknown }>;
let sentEvents: Array<{ kind: string; message: unknown }>;
let notified: unknown[];
let postMarket: (() => void) | null;
let services: BrokerService[];

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

/** ServiceContext con stubs de los servicios que consume el broker. */
const makeCtx = (): ServiceContext => {
  sent = [];
  const ctx: ServiceContext = {
    broadcast: (channel, payload) => {
      sent.push({ channel, payload });
    },
    services: {
      storage: { getDb: () => db } as never,
      secrets: secretsStub() as never,
      settings: {
        get: () => ({
          brokerExecutionEnabled: true,
          deviationMarginPp: 2,
          deviationSlippageBps: 10,
        }),
      } as never,
      connectivity: {
        getState: () => ({ status: 'online', lastCheckedAt: null, nextRetryAt: null, attempt: 0 }),
      } as never,
      killSwitch: { getState: () => ({ active: false }) } as never,
      signals: { engine: { getSignal: (id: number) => signalsRepo.getSignal(id) } } as never,
      journal: journal as never,
      delivery: {
        sendEvent: (kind: string, message: unknown) => {
          sentEvents.push({ kind, message });
        },
      } as never,
      notifications: {
        notify: (payload: unknown) => {
          notified.push(payload);
        },
      } as never,
      backtest: { listRuns: () => [], getRun: () => null } as never,
      strategies: { get: () => null } as never,
      routine: {
        onPostMarket: (listener: () => void) => {
          postMarket = listener;
          return () => {
            postMarket = null;
          };
        },
      } as never,
    },
  };
  return ctx;
};

const register = (ctx = makeCtx()): { ctx: ServiceContext; service: BrokerService } => {
  const service = registerBroker(ctx);
  services.push(service);
  return { ctx, service };
};

const handle = (channel: string): ((...args: unknown[]) => unknown) => {
  const handler = electron.handlers.get(channel);
  if (handler === undefined) throw new Error(`canal no registrado: ${channel}`);
  return handler;
};

/** Espera a que una condición se cumpla (los handlers del gestor son asíncronos). */
const waitFor = async (check: () => boolean, tries = 50): Promise<void> => {
  for (let i = 0; i < tries && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const decision = (patch: Partial<RiskDecision> = {}): RiskDecision => ({
  status: 'aprobada',
  size: 10,
  sizeFactor: 1,
  riskAmount: 100,
  notional: 2000,
  reasons: [],
  decidedAt: new Date().toISOString(),
  ...patch,
});

/** Persiste una señal real (la FK `senal_id` de broker_orders lo exige). */
const seedSignal = (): Signal => {
  const { signal } = signalsRepo.insertSignal({
    ticker: 'AAPL',
    direction: 'largo',
    entry: 200,
    stop: 190,
    target: 220,
    confidence: 0.8,
    reason: 'ruptura del canal',
    strategies: [
      {
        strategyId: 3,
        name: 'Donchian',
        version: 2,
        direction: 'largo',
        confidence: 0.8,
        reason: 'ruptura',
      },
    ],
    dataUsed: {
      barDate: '2026-10-08',
      desde: '2026-09-01',
      hasta: '2026-10-01',
      barCount: 20,
      batchId: null,
      batchVersion: null,
      source: 'simulado',
    },
    decision: decision(),
    barDate: '2026-10-08',
  } satisfies NewSignal);
  return signal;
};

/** Registra el servicio en modo E2E (broker simulado) y conecta la cuenta. */
const connectSimulated = async (): Promise<{ ctx: ServiceContext; service: BrokerService }> => {
  process.env.TRADIA_E2E = '1';
  electron.isPackaged = false;
  const { ctx, service } = register();
  const status = await handle(IPC_CHANNELS.broker.connect)(null, {
    apiKeyId: PAPER_KEY,
    apiSecret: SECRET,
  });
  expect(status).toMatchObject({ state: 'conectada', adapter: 'simulado' });
  return { ctx, service };
};

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createBrokerRepository(db);
  signalsRepo = createSignalsRepository(db);
  journal = createJournalService({
    repo: createJournalRepository(db),
    broadcast: () => undefined,
  });
  keys = new Map();
  sentEvents = [];
  notified = [];
  postMarket = null;
  services = [];
  electron.isPackaged = true;
  electron.handlers.clear();
  delete process.env.TRADIA_E2E;
});

afterEach(() => {
  for (const service of services) service.stop();
  journal.stop();
  db.close();
  delete process.env.TRADIA_E2E;
});

// ---------------------------------------------------------------------------
// Registro de canales
// ---------------------------------------------------------------------------

describe('registerBroker · registro de canales', () => {
  it('registra los canales del contrato y ningún gancho E2E fuera de TRADIA_E2E', () => {
    register();
    for (const channel of [
      IPC_CHANNELS.broker.connect,
      IPC_CHANNELS.broker.disconnect,
      IPC_CHANNELS.broker.status,
      IPC_CHANNELS.broker.test,
      IPC_CHANNELS.orders.list,
      IPC_CHANNELS.orders.cancel,
      IPC_CHANNELS.reconcile.run,
      IPC_CHANNELS.reconcile.status,
      IPC_CHANNELS.deviation.report,
    ]) {
      expect(electron.handlers.has(channel), channel).toBe(true);
    }
    // Sin TRADIA_E2E los ganchos del broker simulado no existen.
    for (const channel of [
      IPC_CHANNELS.broker.failNext,
      IPC_CHANNELS.broker.createDiscrepancy,
      IPC_CHANNELS.broker.seedWeeks,
    ]) {
      expect(electron.handlers.has(channel), channel).toBe(false);
    }
  });

  it('con TRADIA_E2E sin empaquetar registra los ganchos del simulado', () => {
    process.env.TRADIA_E2E = '1';
    electron.isPackaged = false;
    register();
    for (const channel of [
      IPC_CHANNELS.broker.failNext,
      IPC_CHANNELS.broker.createDiscrepancy,
      IPC_CHANNELS.broker.seedWeeks,
    ]) {
      expect(electron.handlers.has(channel), channel).toBe(true);
    }
  });

  it('empaquetada ignora TRADIA_E2E y no registra los ganchos', () => {
    process.env.TRADIA_E2E = '1';
    electron.isPackaged = true;
    register();
    expect(electron.handlers.has(IPC_CHANNELS.broker.failNext)).toBe(false);
    expect(electron.handlers.has(IPC_CHANNELS.broker.seedWeeks)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validación de entradas
// ---------------------------------------------------------------------------

describe('registerBroker · validación de entradas', () => {
  beforeEach(() => {
    process.env.TRADIA_E2E = '1';
    electron.isPackaged = false;
    register();
  });

  it('broker:connect rechaza peticiones sin las dos claves válidas', () => {
    const connect = handle(IPC_CHANNELS.broker.connect);
    for (const bad of [
      null,
      'pk',
      {},
      { apiKeyId: PAPER_KEY },
      { apiSecret: SECRET },
      { apiKeyId: '  ', apiSecret: SECRET },
      { apiKeyId: PAPER_KEY, apiSecret: SECRET, extra: 1 },
      { apiKeyId: 7, apiSecret: SECRET },
    ]) {
      expect(() => connect(null, bad)).toThrow(/entrada inválida/);
    }
    // Nada se guardó: ni una petición inválida toca el almacén.
    expect(keys.size).toBe(0);
  });

  it('broker:test exige las dos claves a la vez o ninguna', () => {
    const test = handle(IPC_CHANNELS.broker.test);
    expect(() => test(null, { apiKeyId: PAPER_KEY })).toThrow(/entrada inválida/);
    expect(() => test(null, { apiKeyId: PAPER_KEY, apiSecret: '' })).toThrow(/entrada inválida/);
    expect(() => test(null, { apiKeyId: PAPER_KEY, apiSecret: SECRET, x: 1 })).toThrow(
      /entrada inválida/,
    );
  });

  it('orders:list valida los filtros del contrato', () => {
    const list = handle(IPC_CHANNELS.orders.list);
    expect(() => list(null, { status: 'no-existe' })).toThrow(/entrada inválida/);
    expect(() => list(null, { limit: 0 })).toThrow(/entrada inválida/);
    expect(() => list(null, { limit: 501 })).toThrow(/entrada inválida/);
    expect(() => list(null, { offset: -1 })).toThrow(/entrada inválida/);
    expect(() => list(null, { sorpresa: 1 })).toThrow(/entrada inválida/);
    expect(list(null, undefined)).toEqual([]);
    expect(list(null, { status: 'pendiente', limit: 10 })).toEqual([]);
  });

  it('orders:cancel exige un id local entero positivo', async () => {
    const cancel = handle(IPC_CHANNELS.orders.cancel);
    for (const bad of [
      null,
      {},
      { id: 'x' },
      { id: 0 },
      { id: -2 },
      { id: 1.5 },
      { id: 1, x: 2 },
    ]) {
      expect(() => cancel(null, bad)).toThrow(/entrada inválida/);
    }
    // Id válido pero sin cuenta conectada: error legible, no validación.
    await expect(cancel(null, { id: 1 })).rejects.toThrow(ERR_BROKER_NO_ACCOUNT);
  });

  it('deviation:report exige un periodo del contrato', () => {
    const report = handle(IPC_CHANNELS.deviation.report);
    for (const bad of [null, {}, { period: 'diario' }, { period: 'semanal', x: 1 }]) {
      expect(() => report(null, bad)).toThrow(/entrada inválida/);
    }
    expect(report(null, { period: 'semanal' })).toMatchObject({
      period: 'semanal',
      marginPp: 2,
      maxSlippageBps: 10,
      rows: [],
    });
  });

  it('los ganchos E2E validan su petición', () => {
    expect(() => handle(IPC_CHANNELS.broker.failNext)(null, { kind: 'x' })).toThrow(
      /entrada inválida/,
    );
    expect(() => handle(IPC_CHANNELS.broker.failNext)(null, {})).toThrow(/entrada inválida/);
    expect(handle(IPC_CHANNELS.broker.failNext)(null, { kind: 'timeout' })).toEqual({
      armed: 'timeout',
    });
    expect(() => handle(IPC_CHANNELS.broker.createDiscrepancy)(null, { kind: 'x' })).toThrow(
      /entrada inválida/,
    );
    expect(() => handle(IPC_CHANNELS.broker.seedWeeks)(null, { weeks: 0 })).toThrow(
      /entrada inválida/,
    );
    expect(() => handle(IPC_CHANNELS.broker.seedWeeks)(null, { weeks: 60 })).toThrow(
      /entrada inválida/,
    );
    expect(() => handle(IPC_CHANNELS.broker.seedWeeks)(null, { weeks: 2, x: 1 })).toThrow(
      /entrada inválida/,
    );
  });
});

// ---------------------------------------------------------------------------
// Conexión y claves
// ---------------------------------------------------------------------------

describe('registerBroker · conexión de la cuenta paper', () => {
  it('conecta con el simulado, guarda las claves cifradas y nunca las expone', async () => {
    await connectSimulated();

    expect(keys.get(BROKER_SECRET_KEYS.apiKeyId)).toBe(PAPER_KEY);
    expect(keys.get(BROKER_SECRET_KEYS.apiSecret)).toBe(SECRET);

    // El estado que llega al renderer no contiene las claves ni sus campos.
    const status = handle(IPC_CHANNELS.broker.status)(null) as Record<string, unknown>;
    expect(status).toMatchObject({
      state: 'conectada',
      adapter: 'simulado',
      executionEnabled: true,
      error: null,
    });
    expect(status.account).toMatchObject({ paper: true });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(PAPER_KEY);
    expect(status).not.toHaveProperty('apiKeyId');
    expect(status).not.toHaveProperty('apiSecret');
  });

  it('broker:test sin argumento prueba las claves guardadas; sin ellas lo dice', async () => {
    process.env.TRADIA_E2E = '1';
    electron.isPackaged = false;
    register();
    const test = handle(IPC_CHANNELS.broker.test);

    await expect(test(null, undefined)).resolves.toMatchObject({
      ok: false,
      error: ERR_BROKER_NO_KEYS,
    });

    await handle(IPC_CHANNELS.broker.connect)(null, { apiKeyId: PAPER_KEY, apiSecret: SECRET });
    const result = (await test(null, {})) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, error: null });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('broker:test con claves nuevas las valida sin guardarlas', async () => {
    process.env.TRADIA_E2E = '1';
    electron.isPackaged = false;
    register();
    const result = await handle(IPC_CHANNELS.broker.test)(null, {
      apiKeyId: 'PKOTRA0001',
      apiSecret: 'otro-secreto-1',
    });
    expect(result).toMatchObject({ ok: true });
    expect(keys.size).toBe(0);
    expect(handle(IPC_CHANNELS.broker.status)(null)).toMatchObject({ state: 'desconectada' });
  });

  it('disconnect borra las claves y deja el estado desconectado', async () => {
    await connectSimulated();
    const status = await handle(IPC_CHANNELS.broker.disconnect)(null);
    expect(status).toMatchObject({ state: 'desconectada', account: null });
    expect(keys.size).toBe(0);
    // Sin gestor de órdenes: cancelar vuelve a dar el error legible.
    await expect(handle(IPC_CHANNELS.orders.cancel)(null, { id: 1 })).rejects.toThrow(
      ERR_BROKER_NO_ACCOUNT,
    );
  });

  it('rechaza claves live de Alpaca antes de guardar nada (modo real)', async () => {
    // Sin E2E el adaptador es Alpaca paper: una clave 'AK*' ni siquiera
    // sale a la red.
    register();
    const status = await handle(IPC_CHANNELS.broker.connect)(null, {
      apiKeyId: LIVE_KEY,
      apiSecret: SECRET,
    });
    expect(status).toMatchObject({ state: 'error', error: ERR_BROKER_LIVE_KEYS });
    expect(keys.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Conciliación, informe y ganchos E2E
// ---------------------------------------------------------------------------

describe('registerBroker · conciliación e informe', () => {
  it('reconcile:run sin cuenta da una ejecución de error, no una excepción', async () => {
    register();
    const run = await handle(IPC_CHANNELS.reconcile.run)(null);
    expect(run).toMatchObject({ trigger: 'manual', result: 'error' });
    expect(handle(IPC_CHANNELS.reconcile.status)(null)).toMatchObject({
      openDiscrepancies: [],
    });
  });

  it('un descuadre fabricado aparece en reconcile:run, en el evento y en el Diario', async () => {
    await connectSimulated();
    // Sin posiciones, el gancho fabrica una que el broker tiene y la app no.
    await handle(IPC_CHANNELS.broker.createDiscrepancy)(null, { kind: 'posicion-cantidad' });

    const run = await handle(IPC_CHANNELS.reconcile.run)(null);
    expect(run).toMatchObject({ trigger: 'manual', result: 'descuadre', discrepancies: 1 });

    const status = handle(IPC_CHANNELS.reconcile.status)(null) as {
      openDiscrepancies: Array<{ type: string; detail: string }>;
    };
    expect(status.openDiscrepancies).toHaveLength(1);
    expect(status.openDiscrepancies[0]!.type).toBe('posicion-faltante-app');

    // El aviso salió por el broadcast (renderer), por los canales y al Diario.
    expect(sent.some((m) => m.channel === IPC_CHANNELS.reconcile.discrepancy)).toBe(true);
    expect(sentEvents.some((e) => e.kind === 'limite-alcanzado')).toBe(true);
    const page = journal.list({});
    expect(page.entries.some((entry) => entry.result === 'error')).toBe(true);
  });

  it('el gancho postmercado de la rutina dispara una conciliación', async () => {
    await connectSimulated();
    expect(postMarket).not.toBeNull();
    await handle(IPC_CHANNELS.broker.createDiscrepancy)(null, { kind: 'posicion-cantidad' });

    postMarket!();
    await waitFor(() => sent.some((m) => m.channel === IPC_CHANNELS.reconcile.discrepancy));

    const status = handle(IPC_CHANNELS.reconcile.status)(null) as {
      lastRun: { trigger: string; result: string } | null;
    };
    expect(status.lastRun).toMatchObject({ trigger: 'rutina', result: 'descuadre' });
  });

  it('broker:seed-weeks siembra operaciones cerradas y deviation:report las informa', async () => {
    await connectSimulated();
    const seeded = await handle(IPC_CHANNELS.broker.seedWeeks)(null, { weeks: 4 });
    expect(seeded).toMatchObject({ orders: 32 });

    const report = handle(IPC_CHANNELS.deviation.report)(null, {
      period: 'semanal',
    }) as { rows: Array<{ strategyId: number; trades: number }> };
    // Cuatro semanas cerradas × 2 estrategias = 8 filas, 2 operaciones cada una.
    expect(report.rows).toHaveLength(8);
    expect(report.rows.every((row) => row.trades === 2)).toBe(true);
    const strategyIds = new Set(report.rows.map((row) => row.strategyId));
    expect(strategyIds.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Cableado de señales
// ---------------------------------------------------------------------------

describe('registerBroker · envoltura de broadcast', () => {
  it('una señal aprobada emitida por signals:new crea la orden con la cuenta conectada', async () => {
    const { ctx } = await connectSimulated();
    const signal = seedSignal();

    ctx.broadcast(IPC_CHANNELS.signals.new, { signal });
    await waitFor(() => repo.listOrders({}).length > 0);

    const orders = repo.listOrders({});
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      clientOrderId: `tradia-${signal.id}-entrada`,
      ticker: 'AAPL',
      type: 'market',
      side: 'buy',
      status: 'ejecutada',
      signalId: signal.id,
    });
    // El evento siguió su camino hacia las ventanas (envoltura transparente).
    expect(sent.some((m) => m.channel === IPC_CHANNELS.signals.new)).toBe(true);
    // La orden nueva se notificó por broker:order-updated.
    expect(sent.some((m) => m.channel === IPC_CHANNELS.broker.orderUpdated)).toBe(true);
  });

  it('sin cuenta conectada la señal no crea ninguna orden', async () => {
    process.env.TRADIA_E2E = '1';
    electron.isPackaged = false;
    const { ctx } = register();
    const signal = seedSignal();

    ctx.broadcast(IPC_CHANNELS.signals.new, { signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(repo.listOrders({})).toEqual([]);
    // El evento siguió llegando al renderer (seguimiento local intacto).
    expect(sent.some((m) => m.channel === IPC_CHANNELS.signals.new)).toBe(true);
  });
});
