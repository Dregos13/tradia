/**
 * Pruebas del servicio del broker real (live/broker.ts): puerta de la
 * lista, ranura de claves live, enrutado de señales con techos y el
 * conmutador del broker real simulado.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JournalRecordInput } from '../../shared/journal';
import { IPC_CHANNELS, IpcValidationError } from '../../shared/ipc';
import type { RiskDecision } from '../../shared/risk';
import type { Signal } from '../../shared/signals';
import {
  LIVE_BROKER_SECRET_KEYS,
  liveConfirmationPhrase,
  type LiveChecklist,
  type LiveLimitsInput,
  type LiveState,
} from '../../shared/live';
import { openDatabase } from '../db/database';
import { createAlpacaLiveBroker } from '../broker/alpacaLive';
import { createAlpacaLiveFakeFetch } from '../broker/__fixtures__/fake-server';
import { createBrokerRepository, type BrokerRepository } from '../broker/repository';
import { createSignalsRepository, type NewSignal } from '../signals/repository';
import type { ServiceContext } from '../services';
import { createSettingsService } from '../services/settings';
import {
  createLiveBrokerService,
  ERR_LIVE_PAPER_KEYS,
  LiveBrokerError,
  type LiveBrokerServiceDeps,
} from './broker';
import { registerLive, type LiveServices } from './index';
import { createLiveStore, type LiveStore } from './service';

// electron solo aporta app/ipcMain a registerLive; mismo patrón que las
// demás pruebas de servicios del proceso principal.
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

const NOW = Date.parse('2026-10-09T15:00:00.000Z');
const LIVE_KEYS = { apiKeyId: 'AKTESTKEY01', apiSecret: 'SK-test-secret' };
const PAPER_KEYS = { apiKeyId: 'PKTESTKEY01', apiSecret: 'SK-test-secret' };
const LIMITS: LiveLimitsInput = {
  capitalUsd: 500,
  orderUsd: 100,
  dailyLossUsd: 10,
  openPositions: 1,
};

let db: Database.Database;
let store: LiveStore;
let liveRepo: BrokerRepository;
let signalsRepo: ReturnType<typeof createSignalsRepository>;
let keys: Map<string, string>;
let journal: JournalRecordInput[];
let gateOpen: boolean;
let nowMs: number;
let fetchCalls: { url: string; method: string }[];
let builtAdapters: number;
let services: ReturnType<typeof createLiveBrokerService>[];
let registeredLive: LiveServices[];

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

const liveStub = () => ({
  getChecklist: () => ({ allComplete: gateOpen }) as unknown as LiveChecklist,
  getState: async () =>
    ({
      mode: store.getMode().estado,
      hasCredentials: keys.has(LIVE_BROKER_SECRET_KEYS.apiKeyId),
      accountMasked: store.getMode().cuenta,
    }) as unknown as LiveState,
});

const liveFakeFetch = (): typeof globalThis.fetch => {
  const inner = createAlpacaLiveFakeFetch({ now: () => nowMs, prices: { AAPL: 200, SPY: 500 } });
  return (input, init) => {
    fetchCalls.push({ url: String(input), method: (init?.method ?? 'GET').toUpperCase() });
    return inner(input, init);
  };
};

const makeService = (extra: Partial<LiveBrokerServiceDeps> = {}) => {
  const service = createLiveBrokerService({
    live: liveStub(),
    store,
    repository: liveRepo,
    secrets: secretsStub(),
    createAdapter: (getCredentials) => {
      builtAdapters += 1;
      return createAlpacaLiveBroker({
        fetch: liveFakeFetch(),
        getCredentials,
        isLiveGateOpen: () => gateOpen,
      });
    },
    createSimulatedAdapter: (getCredentials) =>
      createAlpacaLiveBroker({
        fetch: liveFakeFetch(),
        getCredentials,
        isLiveGateOpen: () => gateOpen,
      }),
    isKillSwitchActive: () => false,
    isOnline: () => true,
    getSignal: (id) => signalsRepo.getSignal(id),
    recordJournal: (input) => journal.push(input),
    now: () => nowMs,
    sleep: async () => undefined,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    ...extra,
  });
  services.push(service);
  return service;
};

const decision = (patch: Partial<RiskDecision> = {}): RiskDecision => ({
  status: 'aprobada',
  size: 1,
  sizeFactor: 1,
  riskAmount: 10,
  notional: 60,
  reasons: [],
  decidedAt: new Date(nowMs).toISOString(),
  ...patch,
});

const seedSignal = (patch: Partial<NewSignal> = {}): Signal =>
  signalsRepo.insertSignal({
    ticker: 'AAPL',
    direction: 'largo',
    entry: 60,
    stop: 50,
    target: 80,
    confidence: 0.8,
    reason: 'ruptura',
    strategies: [
      {
        strategyId: 3,
        name: 'Donchian',
        version: 2,
        direction: 'largo',
        confidence: 0.8,
        reason: 'r',
      },
    ],
    dataUsed: {
      barDate: '2026-10-09',
      desde: '2026-09-01',
      hasta: '2026-10-01',
      barCount: 20,
      batchId: null,
      batchVersion: null,
      source: 'simulado',
    },
    decision: decision(patch.decision),
    barDate: '2026-10-09',
    ...patch,
  }).signal;

const confirmLimits = (input: LiveLimitsInput = LIMITS): void => {
  const at = new Date(nowMs).toISOString();
  store.saveLimits(input, at);
  store.confirmLimits(at);
};

const activateMode = (): void => {
  const at = new Date(nowMs).toISOString();
  store.setMode({
    estado: 'activo',
    motivo: null,
    detalle: null,
    activadoEn: at,
    suspendidoEn: null,
    actualizadoEn: at,
  });
};

const connectActive = async (
  extra: Partial<LiveBrokerServiceDeps> = {},
  input: LiveLimitsInput = LIMITS,
) => {
  gateOpen = true;
  confirmLimits(input);
  activateMode();
  const service = makeService(extra);
  await service.connect(LIVE_KEYS);
  return service;
};

beforeEach(() => {
  db = openDatabase(':memory:');
  store = createLiveStore(db);
  liveRepo = createBrokerRepository(db, { ordersTable: 'broker_orders_live' });
  signalsRepo = createSignalsRepository(db);
  keys = new Map();
  journal = [];
  gateOpen = false;
  nowMs = NOW;
  fetchCalls = [];
  builtAdapters = 0;
  services = [];
  registeredLive = [];
  electron.handlers.clear();
  electron.isPackaged = true;
  delete process.env.TRADIA_E2E;
});

afterEach(() => {
  for (const service of services) service.stop();
  for (const registered of registeredLive) registered.broker.stop();
  vi.unstubAllGlobals();
  db.close();
});

// ---------------------------------------------------------------------------
// Conexión y ranura de claves
// ---------------------------------------------------------------------------

describe('live:connect — puerta y ranura de claves', () => {
  it('sin la lista cumplida no se crea el adaptador ni se guardan claves', async () => {
    const service = makeService();
    await expect(service.connect(LIVE_KEYS)).rejects.toMatchObject({
      name: 'LiveBrokerError',
      code: 'lista-incompleta',
    });
    expect(builtAdapters).toBe(0);
    expect(keys.size).toBe(0);
    expect(fetchCalls).toHaveLength(0);
    expect(
      journal.some(
        (j) => j.type === 'limite' && String(j.reason).includes('lista de comprobación'),
      ),
    ).toBe(true);
  });

  it('unas claves paper en la ranura live se rechazan con mensaje claro y no se guardan', async () => {
    gateOpen = true;
    const service = makeService();
    const error = await service.connect(PAPER_KEYS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LiveBrokerError);
    expect((error as LiveBrokerError).code).toBe('clave-paper');
    expect((error as LiveBrokerError).message).toBe(ERR_LIVE_PAPER_KEYS);
    expect(builtAdapters).toBe(0);
    expect(keys.size).toBe(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it('con la lista cumplida valida la cuenta y guarda las claves en la ranura live', async () => {
    gateOpen = true;
    const service = makeService();
    const state = await service.connect(LIVE_KEYS);

    // Validadas contra la cuenta antes de guardarse (GET /v2/account primero).
    expect(fetchCalls[0]).toMatchObject({
      method: 'GET',
      url: expect.stringContaining('/v2/account'),
    });
    expect(keys.get(LIVE_BROKER_SECRET_KEYS.apiKeyId)).toBe(LIVE_KEYS.apiKeyId);
    expect(keys.get(LIVE_BROKER_SECRET_KEYS.apiSecret)).toBe(LIVE_KEYS.apiSecret);
    // Nunca en la ranura paper.
    expect([...keys.keys()].every((k) => k.startsWith('broker-alpaca-live'))).toBe(true);

    const mode = store.getMode();
    expect(mode.broker).toBe('alpaca');
    expect(mode.cuenta).toMatch(/^•••• /);
    expect(service.adapterId()).toBe('alpaca-live');
    expect(state.hasCredentials).toBe(true);
    expect(journal.some((j) => j.type === 'resumen' && j.result === 'completado')).toBe(true);
  });

  it('una cuenta que no valida no guarda claves', async () => {
    gateOpen = true;
    const service = makeService({
      createAdapter: (getCredentials) =>
        createAlpacaLiveBroker({
          fetch: async () =>
            new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 }),
          getCredentials,
          isLiveGateOpen: () => gateOpen,
        }),
    });
    await expect(service.connect(LIVE_KEYS)).rejects.toMatchObject({
      code: 'validacion-cuenta',
    });
    expect(keys.size).toBe(0);
    expect(store.getMode().broker).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ejecución de señales con techos
// ---------------------------------------------------------------------------

describe('ejecución real con techos de capital', () => {
  it('con modo activo y cuenta la señal ejecuta entrada y OCO en broker_orders_live', async () => {
    const service = await connectActive();
    const signal = seedSignal({ ticker: 'AAPL', entry: 60, decision: decision({ size: 1 }) });

    await service.handleSignalEvent({ signal });

    const entry = liveRepo.getOrderByClientId(`tradia-${signal.id}-entrada`);
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe('ejecutada');
    expect(entry!.leg).toBe('entrada');
    // El OCO de protección se creó al ejecutarse la entrada.
    const exit = liveRepo.getOrderByClientId(`tradia-${signal.id}-salida`);
    expect(exit).not.toBeNull();
    expect(exit!.type).toBe('oco');
    // Y nada cayó en la tabla paper.
    const paperRepo = createBrokerRepository(db);
    expect(paperRepo.listOrders()).toHaveLength(0);
  });

  it('sin modo activo la señal no se envía aunque haya cuenta conectada', async () => {
    gateOpen = true;
    confirmLimits();
    const service = makeService();
    await service.connect(LIVE_KEYS);
    expect(service.liveExecutionActive()).toBe(false);

    const signal = seedSignal();
    await service.handleSignalEvent({ signal });
    expect(liveRepo.listOrders()).toHaveLength(0);
    expect(fetchCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('una orden por encima del techo por orden se bloquea antes de la red, con el motivo en el Diario', async () => {
    const service = await connectActive();
    const postsBefore = fetchCalls.filter((c) => c.method === 'POST').length;
    // 5 acciones a 60 = 300 USD > 100 USD por orden.
    const signal = seedSignal({ entry: 60, decision: decision({ size: 5, notional: 300 }) });

    await service.handleSignalEvent({ signal });

    expect(liveRepo.listOrders()).toHaveLength(0);
    expect(fetchCalls.filter((c) => c.method === 'POST')).toHaveLength(postsBefore);
    const entry = journal.find(
      (j) => j.type === 'error' && String(j.reason).includes('no ejecutada'),
    );
    expect(entry).toBeDefined();
    expect(String(entry!.reason)).toContain('límite por orden');
  });

  it('una posición nueva por encima del máximo se bloquea; ampliar la existente pasa', async () => {
    const service = await connectActive();
    // Posición abierta en AAPL (openPositions = 1).
    const first = seedSignal({ ticker: 'AAPL', entry: 60 });
    await service.handleSignalEvent({ signal: first });
    expect(liveRepo.getOrderByClientId(`tradia-${first.id}-entrada`)!.status).toBe('ejecutada');

    // SPY sería la segunda posición: bloqueada antes de la red.
    const postsBefore = fetchCalls.filter((c) => c.method === 'POST').length;
    const second = seedSignal({ ticker: 'SPY', entry: 60 });
    await service.handleSignalEvent({ signal: second });
    expect(liveRepo.getOrderByClientId(`tradia-${second.id}-entrada`)).toBeNull();
    expect(fetchCalls.filter((c) => c.method === 'POST')).toHaveLength(postsBefore);
  });

  it('el capital en uso + la orden por encima del límite se bloquea', async () => {
    const service = await connectActive();
    // Posición de 450 USD de los 500 de capital, en el mismo ticker de
    // la señal (así el tope de posiciones no bloquea antes que el de capital).
    liveRepo.insertOrder({
      clientOrderId: 'tradia-cap-entrada',
      signalId: null,
      strategyId: 3,
      leg: 'entrada',
      ticker: 'AAPL',
      type: 'market',
      side: 'buy',
      quantity: 4.5,
      filledQuantity: 4.5,
      requestedPrice: 100,
      executedPrice: 100,
      requestedAt: new Date(nowMs).toISOString(),
      executedAt: new Date(nowMs).toISOString(),
      status: 'ejecutada',
    });

    const signal = seedSignal({ entry: 60, decision: decision({ size: 1 }) });
    await service.handleSignalEvent({ signal });
    // 450 en uso + 60 de la orden > 500 de capital.
    expect(liveRepo.getOrderByClientId(`tradia-${signal.id}-entrada`)).toBeNull();
    expect(
      journal.some((j) => j.type === 'error' && String(j.reason).includes('capital real')),
    ).toBe(true);
  });

  it('la pérdida diaria alcanzada bloquea nuevas entradas pero no la salida', async () => {
    const service = await connectActive();
    const iso = new Date(nowMs).toISOString();
    // Operación cerrada hoy con pérdida de 10 USD (= límite diario).
    liveRepo.insertOrder({
      clientOrderId: 'tradia-loss-entrada',
      signalId: null,
      strategyId: 3,
      leg: 'entrada',
      ticker: 'MSFT',
      type: 'market',
      side: 'buy',
      quantity: 1,
      filledQuantity: 1,
      requestedPrice: 100,
      executedPrice: 100,
      requestedAt: iso,
      executedAt: iso,
      status: 'ejecutada',
    });
    liveRepo.insertOrder({
      clientOrderId: 'tradia-loss-salida',
      signalId: null,
      strategyId: 3,
      leg: 'salida',
      ticker: 'MSFT',
      type: 'oco',
      side: 'sell',
      quantity: 1,
      filledQuantity: 1,
      limitPrice: 90,
      requestedPrice: null,
      executedPrice: 90,
      requestedAt: iso,
      executedAt: iso,
      status: 'ejecutada',
    });

    const signal = seedSignal({ entry: 60, decision: decision({ size: 1 }) });
    await service.handleSignalEvent({ signal });
    expect(liveRepo.getOrderByClientId(`tradia-${signal.id}-entrada`)).toBeNull();
    expect(
      journal.some((j) => j.type === 'error' && String(j.reason).includes('pérdida realizada')),
    ).toBe(true);
  });

  it('con la parada de emergencia activa tampoco sale la orden', async () => {
    const service = await connectActive({ isKillSwitchActive: () => true });
    const signal = seedSignal();
    await service.handleSignalEvent({ signal });
    expect(liveRepo.listOrders()).toHaveLength(0);
    expect(
      journal.some((j) => j.type === 'error' && String(j.reason).includes('parada de emergencia')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Enrutado y conmutador E2E
// ---------------------------------------------------------------------------

describe('modo paper/real y broker real simulado', () => {
  it('liveExecutionActive refleja cuenta + modo activo', async () => {
    gateOpen = true;
    const service = makeService();
    expect(service.liveExecutionActive()).toBe(false);
    await service.connect(LIVE_KEYS);
    // Conectada pero sin activar: el paper sigue mandando.
    expect(service.liveExecutionActive()).toBe(false);
    activateMode();
    expect(service.liveExecutionActive()).toBe(true);
    service.stop();
    expect(service.liveExecutionActive()).toBe(false);
  });

  it('useSimulatedBroker conmuta al servidor falso y desconecta la cuenta vigente', async () => {
    const service = await connectActive();
    expect(service.adapterId()).toBe('alpaca-live');

    const state = await service.useSimulatedBroker(true);
    expect(service.adapterId()).toBeNull();
    expect(state.accountMasked).toBeNull();
    expect(store.getMode().broker).toBeNull();

    // Con el conmutador puesto, connect usa el broker real simulado.
    await service.connect(LIVE_KEYS);
    expect(service.adapterId()).toBe('alpaca-live');
    expect(store.getMode().broker).toBe('simulado');
  });

  it('sin factoría simulada el conmutador se rechaza', async () => {
    gateOpen = true;
    const service = makeService({ createSimulatedAdapter: undefined });
    await expect(service.useSimulatedBroker(true)).rejects.toMatchObject({
      code: 'no-e2e',
    });
  });

  it('restore reconecta con las claves guardadas solo si la puerta sigue abierta', async () => {
    keys.set(LIVE_BROKER_SECRET_KEYS.apiKeyId, LIVE_KEYS.apiKeyId);
    keys.set(LIVE_BROKER_SECRET_KEYS.apiSecret, LIVE_KEYS.apiSecret);

    gateOpen = false;
    const blocked = makeService();
    await blocked.restore();
    expect(builtAdapters).toBe(0);
    expect(blocked.adapterId()).toBeNull();

    gateOpen = true;
    const restored = makeService();
    await restored.restore();
    expect(restored.adapterId()).toBe('alpaca-live');
    expect(store.getMode().broker).toBe('alpaca');
  });
});

// ---------------------------------------------------------------------------
// Integración por IPC: registerLive con la lista real
// ---------------------------------------------------------------------------

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`handler no registrado: ${channel}`);
  return handler({}, ...args);
};

/** ServiceContext real con los servicios que consume registerLive. */
const makeLiveCtx = (broadcasts: { channel: string; payload: unknown }[]): ServiceContext => ({
  broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
  services: {
    storage: { getDb: () => db } as never,
    settings: createSettingsService(db),
    secrets: secretsStub() as never,
    journal: { record: (input: JournalRecordInput) => journal.push(input) } as never,
    signals: { engine: { getSignal: (id: number) => signalsRepo.getSignal(id) } } as never,
    connectivity: {
      getState: () => ({ status: 'online', lastCheckedAt: null, nextRetryAt: null, attempt: 0 }),
    } as never,
  },
});

/** Lista completa real: semilla E2E + declaraciones + límites escritos. */
const completeRealChecklist = (service: LiveServices): void => {
  service.seedProgress({
    paperMonths: 4,
    paperTrades: 40,
    deviationPct: -12,
    finalTestDone: true,
    killSwitchTested: true,
    alertsTested: true,
  });
  for (const requirement of [
    'claves-sin-retirada',
    'plan-contingencia',
    'revision-legal',
  ] as const) {
    service.declare({ requirement, confirmed: true });
  }
  service.setLimits(LIMITS);
};

describe('registerLive · IPC del broker real', () => {
  it('live:connect valida la petición en el borde del canal', async () => {
    const ctx = makeLiveCtx([]);
    registeredLive.push(registerLive(ctx));
    await expect(invoke(IPC_CHANNELS.live.connect, { apiKeyId: 'AK' })).rejects.toMatchObject({
      name: 'IpcValidationError',
    });
    await expect(
      invoke(IPC_CHANNELS.live.connect, { apiKeyId: 'AKTESTKEY01' }),
    ).rejects.toMatchObject({ name: 'IpcValidationError' });
    expect(IpcValidationError.prototype instanceof Error).toBe(true);
  });

  it('sin la lista cumplida live:connect se rechaza y no guarda claves (por IPC)', async () => {
    const ctx = makeLiveCtx([]);
    registeredLive.push(registerLive(ctx));
    vi.stubGlobal('fetch', liveFakeFetch());

    await expect(invoke(IPC_CHANNELS.live.connect, LIVE_KEYS)).rejects.toMatchObject({
      code: 'lista-incompleta',
    });
    expect(keys.size).toBe(0);
  });

  it('con la lista cumplida y el modo activo una señal ejecuta en la cuenta real', async () => {
    process.env.TRADIA_E2E = '1';
    electron.isPackaged = false;
    const broadcasts: { channel: string; payload: unknown }[] = [];
    const ctx = makeLiveCtx(broadcasts);
    const live = registerLive(ctx);
    registeredLive.push(live);

    completeRealChecklist(live);
    const limits = await live.getState();
    expect(limits.mode).toBe('listo');

    // Frase literal generada con los límites → modo 'activo'.
    const activation = await live.activate({
      phrase: liveConfirmationPhrase(LIMITS),
    });
    expect(activation.activated).toBe(true);

    // El broker real simulado se habilita por el gancho E2E.
    const enabled = (await invoke(IPC_CHANNELS.live.useSimulatedBroker, {
      enabled: true,
    })) as LiveState;
    expect(enabled.mode).toBe('activo');

    const state = (await invoke(IPC_CHANNELS.live.connect, LIVE_KEYS)) as LiveState;
    expect(state.hasCredentials).toBe(true);
    expect(state.accountMasked).toMatch(/^•••• /);
    expect(keys.get(LIVE_BROKER_SECRET_KEYS.apiKeyId)).toBe(LIVE_KEYS.apiKeyId);

    // Una señal aprobada ejecuta en la tabla live, nunca en la paper.
    const signal = seedSignal();
    ctx.broadcast(IPC_CHANNELS.signals.new, { signal });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const liveOrders = liveRepo.listOrders();
    expect(liveOrders.map((o) => o.clientOrderId)).toContain(`tradia-${signal.id}-entrada`);
    expect(createBrokerRepository(db).listOrders()).toHaveLength(0);
    // Y el cambio de modo llegó a la franja por live:changed.
    expect(broadcasts.some((m) => m.channel === IPC_CHANNELS.live.changed)).toBe(true);
  });

  it('live:use-simulated-broker no se registra fuera de E2E', async () => {
    const ctx = makeLiveCtx([]);
    registeredLive.push(registerLive(ctx));
    expect(electron.handlers.has(IPC_CHANNELS.live.useSimulatedBroker)).toBe(false);
    expect(electron.handlers.has(IPC_CHANNELS.live.connect)).toBe(true);
  });
});
