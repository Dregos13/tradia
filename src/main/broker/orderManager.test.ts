import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JournalRecordInput } from '../../shared/journal';
import type { RiskDecision, SignalDirection } from '../../shared/risk';
import type { Signal } from '../../shared/signals';
import { openDatabase } from '../db/database';
import { createSignalsRepository, type NewSignal } from '../signals/repository';
import { createOrderManager, orderClientId, type OrderManagerDeps } from './orderManager';
import { createBrokerRepository, type BrokerRepository } from './repository';
import { createSimulatedBroker, type SimulatedBroker } from './simulated';

const NOW = Date.parse('2026-10-08T15:00:00.000Z');
const MIN = 60_000;

let nowMs = NOW;
let db: Database.Database;
let repo: BrokerRepository;
let broker: SimulatedBroker;
let journal: JournalRecordInput[];
let updates: string[];
let sleeps: number[];
let gates: { killSwitch: boolean; online: boolean; execution: boolean };
let signals: ReturnType<typeof createSignalsRepository>;
let barSeq = 0;

const decision = (patch: Partial<RiskDecision> = {}): RiskDecision => ({
  status: 'aprobada',
  size: 10,
  sizeFactor: 1,
  riskAmount: 100,
  notional: 2000,
  reasons: [],
  decidedAt: new Date(nowMs).toISOString(),
  ...patch,
});

/** Persiste una señal real (la FK `senal_id` de broker_orders lo exige). */
const seedSignal = (patch: Partial<NewSignal> = {}): Signal => {
  barSeq += 1;
  const { signal } = signals.insertSignal({
    ticker: 'AAPL',
    direction: 'largo',
    entry: 200,
    stop: 190,
    target: 220,
    confidence: 0.8,
    reason: 'ruptura del canal',
    strategies: [{ strategyId: 3, name: 'Donchian', version: 2, direction: 'largo', confidence: 0.8, reason: 'ruptura' }],
    dataUsed: {
      barDate: `2026-10-${String(Math.min(28, barSeq)).padStart(2, '0')}`,
      desde: '2026-09-01',
      hasta: '2026-10-01',
      barCount: 20,
      batchId: null,
      batchVersion: null,
      source: 'simulado',
    },
    decision: decision(patch.decision ? { ...patch.decision } : {}),
    barDate: `2026-10-${String(Math.min(28, barSeq)).padStart(2, '0')}`,
    ...patch,
  });
  return signal;
};

const emit = (signal: Signal | unknown) =>
  manager.handleSignalEvent(typeof signal === 'object' ? { signal } : signal);

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let manager: ReturnType<typeof createOrderManager>;

const makeManager = (patch: Partial<OrderManagerDeps> = {}): void => {
  manager = createOrderManager({
    adapter: broker,
    repository: repo,
    getSignal: (id) => signals.getSignal(id),
    isKillSwitchActive: () => gates.killSwitch,
    isOnline: () => gates.online,
    isExecutionEnabled: () => gates.execution,
    recordJournal: (input) => journal.push(input),
    onOrderUpdated: (order) => updates.push(order.clientOrderId),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => nowMs,
    logger: silent,
    ...patch,
  });
};

beforeEach(() => {
  nowMs = NOW;
  journal = [];
  updates = [];
  sleeps = [];
  barSeq = 0;
  gates = { killSwitch: false, online: true, execution: true };
  db = openDatabase(':memory:');
  repo = createBrokerRepository(db);
  signals = createSignalsRepository(db);
  broker = createSimulatedBroker({ seed: 'ordenes', now: () => nowMs, prices: { AAPL: 200 } });
  makeManager();
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Señales → órdenes
// ---------------------------------------------------------------------------

describe('gestor de órdenes · ejecución de señales', () => {
  it('una señal aprobada envía la entrada de mercado y el OCO de salida', async () => {
    const signal = seedSignal();
    const result = await emit(signal);

    expect(result.outcome).toBe('ejecutada');
    const entry = result.entry!;
    expect(entry.clientOrderId).toBe(orderClientId(signal.id, 'entrada'));
    expect(entry).toMatchObject({
      signalId: signal.id,
      strategyId: 3,
      leg: 'entrada',
      ticker: 'AAPL',
      type: 'market',
      side: 'buy',
      quantity: 10,
      status: 'ejecutada',
      attempts: 1,
    });
    // El broker simulado ejecuta a 200 × (1 + 5 pb) = 200,1 → slippage +5 pb.
    expect(entry.execution.requestedPrice).toBe(200);
    expect(entry.execution.executedPrice).toBeCloseTo(200.1, 4);
    expect(entry.execution.executedAt).not.toBeNull();
    expect(entry.execution.slippageBps).toBeCloseTo(5, 1);

    const exit = result.exit!;
    expect(exit.clientOrderId).toBe(orderClientId(signal.id, 'salida'));
    expect(exit).toMatchObject({
      leg: 'salida',
      type: 'oco',
      side: 'sell',
      quantity: 10,
      limitPrice: 220,
      stopPrice: 190,
      status: 'enviada',
    });
    expect(exit.ocoGroupId).toBeTruthy();
    expect(exit.brokerOrderId).toBeTruthy();
    expect(await broker.getOrderByClientId(exit.clientOrderId)).not.toBeNull();
  });

  it('una señal reducida ejecuta con el tamaño que dio la pasarela', async () => {
    const signal = seedSignal({
      decision: decision({ status: 'reducida', size: 4, sizeFactor: 0.5 }),
    });
    const result = await emit(signal);
    expect(result.entry).toMatchObject({ quantity: 4, status: 'ejecutada' });
    expect(result.exit).toMatchObject({ quantity: 4, type: 'oco' });
  });

  it('una señal corta abre en venta y protege con un OCO de compra', async () => {
    const direction: SignalDirection = 'corto';
    const signal = seedSignal({
      direction,
      stop: 210,
      target: 180,
      ticker: 'MSFT',
      strategies: [
        { strategyId: 4, name: 'RSI', version: 1, direction, confidence: 0.7, reason: 'sobrecompra' },
      ],
    });
    const result = await emit(signal);
    expect(result.entry).toMatchObject({ side: 'sell', status: 'ejecutada' });
    expect(result.exit).toMatchObject({
      side: 'buy',
      type: 'oco',
      limitPrice: 180,
      stopPrice: 210,
    });
  });

  it('una señal vetada o sin tamaño no produce órdenes', async () => {
    const vetada = seedSignal({ decision: decision({ status: 'vetada', size: 0 }) });
    const cero = seedSignal({ decision: decision({ status: 'aprobada', size: 0 }) });
    expect((await emit(vetada)).outcome).toBe('ignorada');
    expect((await emit(cero)).outcome).toBe('ignorada');
    expect(repo.listOrders()).toHaveLength(0);
    expect(await broker.listOrders()).toHaveLength(0);
  });

  it('el evento duplicado de la misma señal no crea una segunda orden', async () => {
    const signal = seedSignal();
    await emit(signal);
    const again = await emit(signal);
    expect(again.outcome).toBe('duplicada');
    expect(repo.listOrders()).toHaveLength(2); // entrada + salida, sin más
    const remote = await broker.listOrders();
    expect(remote.filter((o) => o.clientOrderId === orderClientId(signal.id, 'entrada')))
      .toHaveLength(1);
  });

  it('los envíos quedan bloqueados por la parada, la conexión y el interruptor', async () => {
    for (const gate of ['killSwitch', 'online', 'execution'] as const) {
      gates.killSwitch = gate === 'killSwitch';
      gates.online = gate !== 'online';
      gates.execution = gate !== 'execution';
      const signal = seedSignal({ ticker: `T${gate.slice(0, 2)}` });
      const result = await emit(signal);
      expect(result.outcome).toBe('bloqueada');
      expect(result.entry).toBeNull();
    }
    expect(repo.listOrders()).toHaveLength(0);
    expect(await broker.listOrders()).toHaveLength(0);
    expect(journal.filter((j) => j.type === 'error')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Reintentos y rechazos
// ---------------------------------------------------------------------------

describe('gestor de órdenes · reintentos y rechazos', () => {
  it('timeout con respuesta perdida adopta la orden del broker sin reenviar', async () => {
    broker.failNext('timeout');
    const signal = seedSignal();
    const result = await emit(signal);

    // La orden sí quedó registrada en el broker: la consulta la encuentra.
    expect(result.outcome).toBe('ejecutada');
    expect(result.entry!.attempts).toBe(1);
    expect(result.entry!.brokerOrderId).toBeTruthy();
    expect(repo.listOrders()).toHaveLength(2);
    expect(await broker.listOrders()).toHaveLength(2);
  });

  it('timeout con orden perdida reenvía: 1 orden y 2 intentos', async () => {
    broker.failNext('timeout');
    const signal = seedSignal();
    const clientId = orderClientId(signal.id, 'entrada');
    // El reintento consulta antes; aquí el broker la perdió de verdad.
    makeManager({
      sleep: async (ms) => {
        sleeps.push(ms);
        broker.dropOrder(clientId);
      },
    });
    const result = await emit(signal);

    expect(result.outcome).toBe('ejecutada');
    expect(result.entry!.attempts).toBe(2);
    expect(result.entry!.status).toBe('ejecutada');
    expect(repo.listOrders()).toHaveLength(2);
    expect(await broker.listOrders()).toHaveLength(2);
    expect(sleeps).toEqual([250]);
  });

  it('un 429 respeta el retryAfterMs del broker en la espera', async () => {
    broker.failNext('rate-limit');
    const signal = seedSignal();
    makeManager({ retryBaseMs: 100 });
    await emit(signal);
    const entry = repo.getOrderByClientId(orderClientId(signal.id, 'entrada'))!;
    expect(entry.status).toBe('ejecutada');
    expect(entry.attempts).toBe(2);
    expect(sleeps).toEqual([1000]); // retryAfterMs del 429 manda sobre la base
  });

  it('tres fallos 5xx agotan los intentos sin una cuarta llamada', async () => {
    const spy = vi.spyOn(broker, 'submitOrder');
    broker.setFailing('server');
    const signal = seedSignal();
    const result = await emit(signal);
    broker.setFailing(null);

    expect(spy).toHaveBeenCalledTimes(3);
    expect(result.outcome).toBe('rechazada');
    expect(result.entry).toMatchObject({ status: 'rechazada', attempts: 3 });
    expect(result.entry!.rejectReason).toContain('3 intentos');
    expect(sleeps).toEqual([250, 500]);
    expect(journal.some((j) => j.type === 'error' && j.signalId === signal.id)).toBe(true);
  });

  it('un rechazo de negocio no se reintenta y deja entrada en el diario', async () => {
    const spy = vi.spyOn(broker, 'submitOrder');
    broker.failNext('reject');
    const signal = seedSignal();
    const result = await emit(signal);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('rechazada');
    expect(result.entry).toMatchObject({ status: 'rechazada', attempts: 1 });
    expect(result.entry!.rejectReason).toContain('reject');
    const entry = journal.find((j) => j.type === 'error');
    expect(entry).toBeDefined();
    expect(entry!.reason).toContain(orderClientId(signal.id, 'entrada'));
  });

  it('un error no tipado tampoco se reintenta', async () => {
    const weird = {
      ...broker,
      submitOrder: () => Promise.reject(new Error('boom inesperado')),
    };
    makeManager({ adapter: weird });
    const signal = seedSignal();
    const result = await emit(signal);
    expect(result.entry).toMatchObject({ status: 'rechazada', attempts: 1 });
    expect(result.entry!.rejectReason).toContain('boom inesperado');
  });
});

// ---------------------------------------------------------------------------
// Huérfanas y sincronización
// ---------------------------------------------------------------------------

describe('gestor de órdenes · huérfanas y sincronización', () => {
  it('una pendiente local sin respuesta tras 2 min queda huérfana', async () => {
    const { order } = repo.insertOrder({
      clientOrderId: 'tradia-90-entrada',
      leg: 'entrada',
      ticker: 'AAPL',
      type: 'market',
      side: 'buy',
      quantity: 5,
      requestedPrice: 200,
      requestedAt: new Date(nowMs - 3 * MIN).toISOString(),
      status: 'pendiente',
      attempts: 1,
    });
    repo.insertOrder({
      clientOrderId: 'tradia-91-entrada',
      leg: 'entrada',
      ticker: 'AAPL',
      type: 'market',
      side: 'buy',
      quantity: 5,
      requestedPrice: 200,
      requestedAt: new Date(nowMs - 30_000).toISOString(), // aún dentro del margen
      status: 'pendiente',
      attempts: 1,
    });

    const result = await manager.syncWithBroker();
    expect(result.orphanedLocal).toBe(1);
    expect(repo.getOrder(order.id)!.status).toBe('huerfana');
    expect(repo.getOrderByClientId('tradia-91-entrada')!.status).toBe('pendiente');
  });

  it('una abierta local que el broker ya no conoce queda huérfana', async () => {
    const remote = await broker.submitOrder({
      clientOrderId: 'tradia-92-entrada',
      ticker: 'AAPL',
      type: 'limit',
      side: 'buy',
      quantity: 5,
      limitPrice: 100,
    });
    repo.insertOrder({
      clientOrderId: 'tradia-92-entrada',
      brokerOrderId: remote.brokerOrderId,
      leg: 'entrada',
      ticker: 'AAPL',
      type: 'limit',
      side: 'buy',
      quantity: 5,
      requestedPrice: 100,
      requestedAt: new Date(nowMs).toISOString(),
      status: 'enviada',
      attempts: 1,
    });
    broker.dropOrder('tradia-92-entrada');

    const result = await manager.syncWithBroker();
    expect(result.orphanedLocal).toBe(1);
    expect(repo.getOrderByClientId('tradia-92-entrada')!.status).toBe('huerfana');
  });

  it('una pendiente que el broker sí tiene se adopta en vez de huérfana', async () => {
    broker.injectPhantomOrder({
      clientOrderId: 'tradia-93-entrada',
      ticker: 'AAPL',
      type: 'market',
      side: 'buy',
      quantity: 5,
      status: 'ejecutada',
      filledQuantity: 5,
      filledAvgPrice: 200.05,
      filledAt: new Date(nowMs).toISOString(),
    });
    repo.insertOrder({
      clientOrderId: 'tradia-93-entrada',
      leg: 'entrada',
      ticker: 'AAPL',
      type: 'market',
      side: 'buy',
      quantity: 5,
      requestedPrice: 200,
      requestedAt: new Date(nowMs - 3 * MIN).toISOString(),
      status: 'pendiente',
      attempts: 1,
    });

    const result = await manager.syncWithBroker();
    const order = repo.getOrderByClientId('tradia-93-entrada')!;
    expect(result.orphanedLocal).toBe(0);
    expect(order.status).toBe('ejecutada');
    expect(order.execution.executedPrice).toBe(200.05);
  });

  it('una orden tradia-* del broker sin registro local se importa huérfana', async () => {
    broker.injectPhantomOrder({ ticker: 'MSFT', quantity: 3, type: 'limit', limitPrice: 150 });
    // Una remota que no es nuestra (sin prefijo) se ignora.
    broker.injectPhantomOrder({ clientOrderId: 'manual-xyz', ticker: 'MSFT' });

    const result = await manager.syncWithBroker();
    expect(result.orphanedRemote).toBe(1);
    const orphan = repo.listOrders({ status: 'huerfana' });
    expect(orphan).toHaveLength(1);
    expect(orphan[0]).toMatchObject({
      ticker: 'MSFT',
      type: 'limit',
      quantity: 3,
      status: 'huerfana',
      signalId: null,
      leg: null,
    });
    expect(orphan[0]!.brokerOrderId).toBeTruthy();
    // Una segunda pasada no la duplica.
    const second = await manager.syncWithBroker();
    expect(second.orphanedRemote).toBe(0);
  });

  it('la sincronización no marca nada si el broker no responde', async () => {
    repo.insertOrder({
      clientOrderId: 'tradia-94-entrada',
      leg: 'entrada',
      ticker: 'AAPL',
      type: 'market',
      side: 'buy',
      quantity: 5,
      requestedPrice: 200,
      requestedAt: new Date(nowMs - 3 * MIN).toISOString(),
      status: 'pendiente',
      attempts: 1,
    });
    broker.setFailing('server');
    const result = await manager.syncWithBroker();
    broker.setFailing(null);
    expect(result.unreachable).toBe(true);
    expect(result.orphanedLocal).toBe(0);
    expect(repo.getOrderByClientId('tradia-94-entrada')!.status).toBe('pendiente');
  });

  it('la ejecución tardía de la entrada lanza el OCO en la pasada de sync', async () => {
    const signal = seedSignal();
    // La entrada queda abierta: simulamos una limit no cruzable rellenando
    // el registro como si el envío hubiera sido asíncrono.
    const remote = await broker.submitOrder({
      clientOrderId: orderClientId(signal.id, 'entrada'),
      ticker: 'AAPL',
      type: 'limit',
      side: 'buy',
      quantity: 10,
      limitPrice: 100,
    });
    repo.insertOrder({
      clientOrderId: orderClientId(signal.id, 'entrada'),
      brokerOrderId: remote.brokerOrderId,
      signalId: signal.id,
      leg: 'entrada',
      ticker: 'AAPL',
      type: 'limit',
      side: 'buy',
      quantity: 10,
      requestedPrice: 100,
      requestedAt: new Date(nowMs).toISOString(),
      status: 'enviada',
      attempts: 1,
    });
    broker.fillOrder(orderClientId(signal.id, 'entrada'), { price: 200.05 });

    const result = await manager.syncWithBroker();
    expect(result.exitsCreated).toBe(1);
    const exit = repo.getOrderByClientId(orderClientId(signal.id, 'salida'))!;
    expect(exit).toMatchObject({ type: 'oco', side: 'sell', limitPrice: 220, stopPrice: 190 });
    expect(exit.status).toBe('enviada');
  });
});

// ---------------------------------------------------------------------------
// Slippage y cancelación
// ---------------------------------------------------------------------------

describe('gestor de órdenes · slippage y cancelación', () => {
  it('el slippage es positivo en compra y en venta cuando la ejecución es peor', async () => {
    const buy = seedSignal();
    const buyResult = await emit(buy);
    expect(buyResult.entry!.execution.slippageBps).toBeCloseTo(5, 1);
    expect(buyResult.entry!.execution.slippageBps!).toBeGreaterThan(0);

    broker.setPrice('MSFT', 200);
    const sell = seedSignal({
      ticker: 'MSFT',
      direction: 'corto',
      stop: 210,
      target: 180,
    });
    const sellResult = await emit(sell);
    // Venta ejecutada a 199,9 frente a 200 pedidos: también desfavorable.
    expect(sellResult.entry!.side).toBe('sell');
    expect(sellResult.entry!.execution.slippageBps).toBeCloseTo(5, 1);
    expect(sellResult.entry!.execution.slippageBps!).toBeGreaterThan(0);
  });

  it('una ejecución mejor que lo pedido da slippage negativo', async () => {
    broker.setPrice('AAPL', 190); // mejora de 200 a 190 en la compra
    const signal = seedSignal();
    const result = await emit(signal);
    // 190,095 ejecutado frente a 200 pedidos → ≈ −495 pb.
    expect(result.entry!.execution.slippageBps!).toBeLessThan(0);
    expect(result.entry!.execution.slippageBps).toBeCloseTo(-495, 0);
  });

  it('al ejecutarse la pata stop del OCO el slippage usa su nivel', async () => {
    const signal = seedSignal();
    const result = await emit(signal);
    const exit = result.exit!;
    broker.setPrice('AAPL', 180); // toca el stop de 190
    broker.tick('AAPL');

    await manager.syncWithBroker();
    const updated = repo.getOrder(exit.id)!;
    expect(updated.status).toBe('ejecutada');
    expect(updated.execution.requestedPrice).toBe(190);
    // Venta a 180 frente al stop de 190: 5,26 % desfavorable → +526 pb.
    expect(updated.execution.slippageBps!).toBeGreaterThan(0);
    expect(updated.execution.slippageBps).toBeCloseTo(526.32, 1);
  });

  it('cancela una orden abierta y refleja el estado del broker', async () => {
    const remote = await broker.submitOrder({
      clientOrderId: 'tradia-95-suelta',
      ticker: 'AAPL',
      type: 'limit',
      side: 'buy',
      quantity: 5,
      limitPrice: 100,
    });
    const { order } = repo.insertOrder({
      clientOrderId: 'tradia-95-suelta',
      brokerOrderId: remote.brokerOrderId,
      ticker: 'AAPL',
      type: 'limit',
      side: 'buy',
      quantity: 5,
      limitPrice: 100,
      requestedPrice: 100,
      requestedAt: new Date(nowMs).toISOString(),
      status: 'enviada',
      attempts: 1,
    });

    const canceled = await manager.cancelOrder(order.id);
    expect(canceled.status).toBe('cancelada');
    await expect(manager.cancelOrder(order.id)).rejects.toMatchObject({ kind: 'reject' });
    await expect(manager.cancelOrder(999)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('notifica cada cambio de orden por el gancho de eventos', async () => {
    const signal = seedSignal();
    await emit(signal);
    expect(updates.length).toBeGreaterThanOrEqual(2); // entrada + salida
    expect(updates).toContain(orderClientId(signal.id, 'entrada'));
    expect(updates).toContain(orderClientId(signal.id, 'salida'));
  });
});
