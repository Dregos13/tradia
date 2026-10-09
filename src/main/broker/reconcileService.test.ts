import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReconcileDiscrepancyEvent, ReconcileRun } from '../../shared/broker';
import type { DeliveryEventKind, JournalRecordInput } from '../../shared/journal';
import type { DeliveryMessage } from '../delivery';
import { openDatabase } from '../db/database';
import { createBrokerRepository, type BrokerRepository } from './repository';
import { createSimulatedBroker, type SimulatedBroker } from './simulated';
import {
  createReconcileService,
  RECONCILE_INTERVAL_MS,
  type ReconcileService,
  type ReconcileServiceDeps,
} from './reconcileService';
import type { RemoteOrder } from './types';

const NOW = Date.parse('2026-10-08T21:00:00.000Z');
const T0 = '2026-10-08T20:00:00.000Z';

const nowMs = NOW;
let db: Database.Database;
let repo: BrokerRepository;
let broker: SimulatedBroker;
let journal: JournalRecordInput[];
let events: { kind: DeliveryEventKind; message: DeliveryMessage }[];
let emitted: ReconcileDiscrepancyEvent[];
let online: boolean;
let adapterPresent: boolean;
let timers: { id: number; cb: () => void; ms: number }[];
let nextTimerId: number;

const silent = { info: () => {}, warn: () => {}, error: () => {} };

const makeService = (patch: Partial<ReconcileServiceDeps> = {}): ReconcileService =>
  createReconcileService({
    getAdapter: () => (adapterPresent ? broker : null),
    repository: repo,
    isOnline: () => online,
    recordJournal: (input) => {
      journal.push(input);
    },
    sendEvent: (kind, message) => {
      events.push({ kind, message });
    },
    emitDiscrepancy: (event) => {
      emitted.push(event);
    },
    now: () => nowMs,
    setTimer: (cb, ms) => {
      const timer = { id: ++nextTimerId, cb, ms };
      timers.push(timer);
      return timer.id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== (id as unknown as number));
    },
    logger: silent,
    ...patch,
  });

const fireTimers = (): void => {
  const pending = [...timers];
  timers.length = 0;
  for (const t of pending) t.cb();
};

/** Orden de mercado ejecutada en el broker y su fila local espejo. */
const seedFilledEntry = async (
  clientOrderId = 'tradia-1-entrada',
  quantity = 10,
): Promise<RemoteOrder> => {
  const remote = await broker.submitOrder({
    clientOrderId,
    ticker: 'AAPL',
    type: 'market',
    side: 'buy',
    quantity,
  });
  repo.insertOrder({
    clientOrderId,
    brokerOrderId: remote.brokerOrderId,
    signalId: null,
    leg: 'entrada',
    ticker: 'AAPL',
    type: 'market',
    side: 'buy',
    quantity,
    filledQuantity: remote.filledQuantity,
    requestedPrice: 100,
    requestedAt: T0,
    executedPrice: remote.filledAvgPrice,
    executedAt: remote.filledAt,
    status: 'ejecutada',
    attempts: 1,
  });
  return remote;
};

/** Orden limitada abierta en el broker y su fila local 'enviada'. */
const seedOpenOrder = async (clientOrderId = 'tradia-2-limitada'): Promise<RemoteOrder> => {
  const remote = await broker.submitOrder({
    clientOrderId,
    ticker: 'MSFT',
    type: 'limit',
    side: 'buy',
    quantity: 5,
    limitPrice: 1, // por debajo del precio: queda abierta
  });
  repo.insertOrder({
    clientOrderId,
    brokerOrderId: remote.brokerOrderId,
    signalId: null,
    leg: null,
    ticker: 'MSFT',
    type: 'limit',
    side: 'buy',
    quantity: 5,
    limitPrice: 1,
    requestedPrice: 1,
    requestedAt: T0,
    status: 'enviada',
    attempts: 1,
  });
  return remote;
};

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createBrokerRepository(db);
  broker = createSimulatedBroker({ now: () => nowMs, prices: { AAPL: 100, MSFT: 200 } });
  journal = [];
  events = [];
  emitted = [];
  online = true;
  adapterPresent = true;
  timers = [];
  nextTimerId = 0;
});

afterEach(() => {
  db.close();
});

describe('conciliación a demanda', () => {
  it('una ejecución sin diferencias no avisa: resultado ok y sin rastro de descuadre', async () => {
    await seedFilledEntry();
    const service = makeService();
    const run = await service.runNow('manual');

    expect(run.result).toBe('ok');
    expect(run.trigger).toBe('manual');
    expect(run.positionsApp).toBe(1);
    expect(run.positionsBroker).toBe(1);
    expect(run.discrepancies).toBe(0);
    expect(repo.listOpenDiscrepancies()).toHaveLength(0);
    expect(journal).toHaveLength(0);
    expect(events).toHaveLength(0);
    // El evento llega igualmente con la lista vacía (el banner se cierra).
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.discrepancies).toHaveLength(0);
    expect(service.status().lastRun?.id).toBe(run.id);
  });

  it('una posición alterada y una orden borrada producen exactamente esos descuadres', async () => {
    await seedFilledEntry();
    await seedOpenOrder();
    broker.tamperPosition('AAPL', { quantity: 8 });
    broker.dropOrder('tradia-2-limitada');

    const service = makeService();
    const run = await service.runNow('programada');

    expect(run.result).toBe('descuadre');
    expect(run.discrepancies).toBe(2);
    const open = repo.listOpenDiscrepancies();
    expect(open.map((d) => d.type)).toEqual(['posicion-cantidad', 'orden-faltante-broker']);
    // Texto legible en español con la diferencia concreta.
    expect(open[0]!.detail).toContain('AAPL');
    expect(open[0]!.detail).toContain('10');
    expect(open[0]!.detail).toContain('8');
    expect(open[1]!.detail).toContain('tradia-2-limitada');

    // Una entrada 'error' en el Diario, una notificación por los canales
    // y el evento reconcile:discrepancy con los abiertos.
    expect(journal).toHaveLength(1);
    expect(journal[0]!.type).toBe('error');
    expect(journal[0]!.errors).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('limite-alcanzado');
    expect(events[0]!.message.title).toBe('Descuadre con el broker');
    expect(events[0]!.message.navigateTo).toBe('ordenes');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.discrepancies.map((d) => d.id)).toEqual(open.map((d) => d.id));
  });

  it('el mismo descuadre no se duplica ni reavisa en la siguiente pasada', async () => {
    await seedFilledEntry();
    broker.tamperPosition('AAPL', { quantity: 8 });
    const service = makeService();

    const first = await service.runNow('programada');
    expect(first.result).toBe('descuadre');
    const second = await service.runNow('programada');
    expect(second.result).toBe('descuadre');
    expect(second.discrepancies).toBe(0); // ya estaba abierto, no hay nuevo

    expect(repo.listOpenDiscrepancies()).toHaveLength(1);
    expect(journal).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]!.discrepancies).toHaveLength(1);
  });

  it('una ejecución limpia marca el aviso como resuelto', async () => {
    await seedFilledEntry();
    broker.tamperPosition('AAPL', { quantity: 8 });
    const service = makeService();
    await service.runNow('manual');
    expect(service.status().openDiscrepancies).toHaveLength(1);

    broker.tamperPosition('AAPL', { quantity: 10 }); // el broker vuelve a cuadrar
    const run = await service.runNow('manual');

    expect(run.result).toBe('ok');
    expect(service.status().openDiscrepancies).toHaveLength(0);
    const resolved = repo.listRunDiscrepancies(repo.listReconcileRuns()[1]!.id);
    expect(resolved[0]!.status).toBe('resuelta');
    expect(resolved[0]!.resolvedAt).not.toBeNull();
    // La ejecución limpia emite la lista vacía: el banner se cierra.
    expect(emitted.at(-1)!.discrepancies).toHaveLength(0);
    // Resolver no vuelve a avisar.
    expect(events).toHaveLength(1);
  });

  it('una orden fantasma en el broker → orden-faltante-app', async () => {
    broker.injectPhantomOrder({ clientOrderId: 'tradia-fantasma-1' });
    const service = makeService();
    const run = await service.runNow('manual');
    expect(run.result).toBe('descuadre');
    const open = repo.listOpenDiscrepancies();
    expect(open.map((d) => d.type)).toEqual(['orden-faltante-app']);
    expect(open[0]!.detail).toContain('tradia-fantasma-1');
  });

  it('guarda el origen rutina y resuelve solo los descuadres ya ausentes', async () => {
    await seedFilledEntry();
    broker.tamperPosition('AAPL', { quantity: 8 });
    broker.injectPhantomOrder({ clientOrderId: 'tradia-fantasma-1' });
    const service = makeService();
    const run = await service.runNow('rutina');
    expect(run.trigger).toBe('rutina');
    expect(repo.listOpenDiscrepancies()).toHaveLength(2);

    // La posición vuelve a cuadrar pero la fantasma sigue: solo se
    // resuelve el descuadre de posición.
    broker.tamperPosition('AAPL', { quantity: 10 });
    await service.runNow('rutina');
    const open = repo.listOpenDiscrepancies();
    expect(open).toHaveLength(1);
    expect(open[0]!.type).toBe('orden-faltante-app');
  });

  it('sin cuenta conectada o sin conexión la pasada queda en error', async () => {
    adapterPresent = false;
    const service = makeService();
    const run = await service.runNow('manual');
    expect(run.result).toBe('error');
    expect(run.error).toContain('no está conectada');
    expect(journal.at(-1)!.type).toBe('error');

    adapterPresent = true;
    online = false;
    const offline = await service.runNow('manual');
    expect(offline.result).toBe('error');
    expect(offline.error).toBe('sin conexión');
  });

  it('un broker que no responde deja la ejecución en error sin tocar los abiertos', async () => {
    await seedFilledEntry();
    broker.tamperPosition('AAPL', { quantity: 8 });
    const service = makeService();
    await service.runNow('manual');
    expect(service.status().openDiscrepancies).toHaveLength(1);

    broker.setFailing('server');
    const run = await service.runNow('manual');
    expect(run.result).toBe('error');
    expect(service.status().openDiscrepancies).toHaveLength(1); // sin resolver

    broker.setFailing(null);
    const recovered = await service.runNow('manual');
    expect(recovered.result).toBe('descuadre');
  });

  it('dos disparos simultáneos se serializan en dos ejecuciones', async () => {
    const service = makeService();
    const [a, b] = await Promise.all([service.runNow('manual'), service.runNow('programada')]);
    expect(a.id).not.toBe(b.id);
    const runs: ReconcileRun[] = repo.listReconcileRuns();
    expect(runs).toHaveLength(2);
  });
});

describe('temporizador de la conciliación programada', () => {
  it('arma la pasada cada 15 minutos con cuenta conectada y conexión', async () => {
    const service = makeService();
    service.start();
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(RECONCILE_INTERVAL_MS);

    fireTimers();
    await vi.waitFor(() => expect(repo.listReconcileRuns()).toHaveLength(1));
    expect(repo.listReconcileRuns()[0]!.trigger).toBe('programada');
    // Tras cada pasada se rearma el siguiente tick.
    expect(timers).toHaveLength(1);
    service.stop();
  });

  it('respeta la pausa por desconexión y por cuenta no conectada', async () => {
    online = false;
    const service = makeService();
    service.start();
    fireTimers();
    await Promise.resolve();
    expect(repo.listReconcileRuns()).toHaveLength(0);

    adapterPresent = false;
    online = true;
    fireTimers();
    await Promise.resolve();
    expect(repo.listReconcileRuns()).toHaveLength(0);

    adapterPresent = true;
    fireTimers();
    await vi.waitFor(() => expect(repo.listReconcileRuns()).toHaveLength(1));
    service.stop();
  });

  it('stop desarma el temporizador', () => {
    const service = makeService();
    service.start();
    service.stop();
    expect(timers).toHaveLength(0);
    fireTimers();
    expect(repo.listReconcileRuns()).toHaveLength(0);
  });
});
