/**
 * Pruebas de la prueba de humo del modo real (live/smoke.ts): el flujo
 * completo compra → cierre → conciliación contra el servidor falso live,
 * los rechazos previos a la red y la suspensión tras cada tipo de fallo.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JournalRecordInput } from '../../shared/journal';
import {
  LIVE_SMOKE_NOTIONAL_USD,
  LIVE_SMOKE_TICKER,
  type LiveLimitsInput,
  type LiveSmokeTestResult,
} from '../../shared/live';
import { openDatabase } from '../db/database';
import { createAlpacaLiveBroker } from '../broker/alpacaLive';
import { createAlpacaLiveFakeFetch } from '../broker/__fixtures__/fake-server';
import { positionsFromOrders } from '../broker/reconcile';
import { createReconcileService } from '../broker/reconcileService';
import { createBrokerRepository, type BrokerRepository } from '../broker/repository';
import {
  BrokerError,
  type BrokerAdapter,
  type BrokerOrderRequest,
  type RemoteOrder,
} from '../broker/types';
import { liveOrderBlockReason, type LiveOrderSnapshot } from './orderGuard';
import { createLiveStore, type LiveStore } from './service';
import { createLiveSmokeTest, type LiveSmokeDeps } from './smoke';

const NOW = Date.parse('2026-10-09T15:00:00.000Z');
const LIMITS: LiveLimitsInput = {
  capitalUsd: 500,
  orderUsd: 100,
  dailyLossUsd: 10,
  openPositions: 1,
};
const SILENT = { info: () => undefined, warn: () => undefined, error: () => undefined };

let db: Database.Database;
let store: LiveStore;
let liveRepo: BrokerRepository;
let journal: JournalRecordInput[];
let suspensions: string[];
let emits: number;
let nowMs: number;
let fetchCalls: { url: string; method: string; body: string }[];

const iso = (): string => new Date(nowMs).toISOString();

const confirmLimits = (input: LiveLimitsInput = LIMITS): void => {
  store.saveLimits(input, iso());
  store.confirmLimits(iso());
};

const activateMode = (): void => {
  store.setMode({
    estado: 'activo',
    motivo: null,
    detalle: null,
    activadoEn: iso(),
    suspendidoEn: null,
    actualizadoEn: iso(),
  });
};

const suspendStub = (detail: string): void => {
  suspensions.push(detail);
  const mode = store.getMode();
  if (mode.estado === 'activo') {
    store.setMode({
      estado: 'suspendido',
      motivo: 'requisito-vencido',
      detalle: detail,
      activadoEn: mode.activado_en,
      suspendidoEn: iso(),
      actualizadoEn: iso(),
    });
  }
};

/** Servidor falso live que además anota las llamadas (con SPY a 500). */
const liveFakeFetch = (positions: unknown[] = []): typeof globalThis.fetch => {
  const inner = createAlpacaLiveFakeFetch({
    now: () => nowMs,
    prices: { SPY: 500 },
    positions,
  });
  return (input, init) => {
    fetchCalls.push({
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: String(init?.body ?? ''),
    });
    return inner(input, init);
  };
};

const liveAdapter = (fetch: typeof globalThis.fetch): BrokerAdapter =>
  createAlpacaLiveBroker({
    fetch,
    getCredentials: async () => ({ apiKeyId: 'AK-TEST', apiSecret: 'SK-TEST' }),
    isLiveGateOpen: () => true,
  });

/** Exposición para la guarda de techos, como la arma el servicio real. */
const snapshot = (mode: LiveOrderSnapshot['mode'] = 'activo'): LiveOrderSnapshot => {
  const limitsRow = store.getLimits();
  const positions = positionsFromOrders(liveRepo.listOrders());
  return {
    mode,
    limits:
      limitsRow !== null && limitsRow.confirmados === 1
        ? {
            capitalUsd: limitsRow.capital_usd,
            orderUsd: limitsRow.orden_usd,
            dailyLossUsd: limitsRow.perdida_diaria_usd,
            openPositions: limitsRow.posiciones_max,
          }
        : null,
    openTickers: positions.map((p) => p.ticker),
    capitalInUseUsd: positions.reduce((s, p) => s + p.quantity * p.avgEntryPrice, 0),
    realizedLossTodayUsd: 0,
  };
};

interface SmokeHarness {
  smoke: ReturnType<typeof createLiveSmokeTest>;
  adapter: BrokerAdapter;
}

/** Monta la prueba con adaptador y conciliación reales sobre el falso. */
const makeSmoke = (
  fetch: typeof globalThis.fetch = liveFakeFetch(),
  extra: Partial<LiveSmokeDeps> = {},
): SmokeHarness => {
  const adapter = liveAdapter(fetch);
  const reconcile = createReconcileService({
    getAdapter: () => adapter,
    repository: liveRepo,
    isOnline: () => true,
    recordJournal: (input) => journal.push(input),
    now: () => nowMs,
    logger: SILENT,
  });
  const smoke = createLiveSmokeTest({
    getAdapter: () => adapter,
    repository: liveRepo,
    store,
    getChecklist: () => ({ allComplete: true }),
    checkOrderAllowed: (request, context) => liveOrderBlockReason(snapshot(), request, context),
    // Cierre de la última sesión cerrada frente al reloj (2026-10-09
    // 15:00 UTC, viernes): la referencia cuenta como reciente.
    referencePrice: () => ({ price: 500, asOf: '2026-10-08' }),
    reconcileNow: () => reconcile.runNow('manual'),
    openDiscrepancyCount: () => reconcile.status().openDiscrepancies.length,
    suspend: suspendStub,
    isKillSwitchActive: () => false,
    isOnline: () => true,
    recordJournal: (input) => journal.push(input),
    emitChanged: () => {
      emits += 1;
    },
    now: () => nowMs,
    sleep: async () => undefined,
    logger: SILENT,
    ...extra,
  });
  return { smoke, adapter };
};

/** Adaptador mínimo programable para los fallos que el falso no produce. */
const stubAdapter = (overrides: Partial<BrokerAdapter> = {}): BrokerAdapter => ({
  id: 'alpaca-live',
  paperOnly: false,
  getAccount: async () => {
    throw new Error('no usado');
  },
  listPositions: async () => [],
  listOrders: async () => [],
  getOrderByClientId: async () => null,
  submitOrder: async () => {
    throw new BrokerError('reject', 'rechazo de negocio simulado', { adapter: 'stub' });
  },
  cancelOrder: async () => {
    throw new BrokerError('not-found', 'desconocida', { adapter: 'stub' });
  },
  ...overrides,
});

const remoteOf = (request: BrokerOrderRequest, patch: Partial<RemoteOrder> = {}): RemoteOrder => ({
  brokerOrderId: `remote-${request.clientOrderId}`,
  clientOrderId: request.clientOrderId,
  ticker: request.ticker,
  type: request.type,
  side: request.side,
  quantity: request.quantity,
  filledQuantity: request.quantity,
  limitPrice: request.limitPrice ?? null,
  stopPrice: request.stopPrice ?? null,
  status: 'ejecutada',
  submittedAt: iso(),
  filledAt: iso(),
  filledAvgPrice: 500,
  ocoGroupId: null,
  legs: null,
  ...patch,
});

const persisted = (): LiveSmokeTestResult | null => {
  const raw = store.getMode().prueba_humo;
  return raw === null ? null : (JSON.parse(raw) as LiveSmokeTestResult);
};

const postCalls = () => fetchCalls.filter((c) => c.method === 'POST');

beforeEach(() => {
  db = openDatabase(':memory:');
  store = createLiveStore(db);
  liveRepo = createBrokerRepository(db, { ordersTable: 'broker_orders_live' });
  journal = [];
  suspensions = [];
  emits = 0;
  nowMs = NOW;
  fetchCalls = [];
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Rechazos previos a la red (sin suspensión, sin estado persistido)
// ---------------------------------------------------------------------------

describe('live:smoke-test — puertas previas', () => {
  it('sin el modo real activo se rechaza antes de tocar la red', async () => {
    const { smoke } = makeSmoke();
    // Sin límites ni activación: el modo queda 'bloqueado'.
    await expect(smoke.run({ confirm: true })).rejects.toMatchObject({
      name: 'LiveSmokeError',
      code: 'modo-no-activo',
    });
    expect(postCalls()).toHaveLength(0);
    expect(liveRepo.listOrders()).toHaveLength(0);
    expect(persisted()).toBeNull();
    expect(suspensions).toHaveLength(0);
  });

  it('sin cuenta conectada se rechaza con código claro', async () => {
    confirmLimits();
    activateMode();
    const { smoke } = makeSmoke(liveFakeFetch(), { getAdapter: () => null });
    await expect(smoke.run({ confirm: true })).rejects.toMatchObject({ code: 'sin-cuenta' });
    expect(postCalls()).toHaveLength(0);
  });

  it('con la parada activa o sin conexión se rechaza', async () => {
    confirmLimits();
    activateMode();
    const stopped = makeSmoke(liveFakeFetch(), { isKillSwitchActive: () => true });
    await expect(stopped.smoke.run({ confirm: true })).rejects.toMatchObject({
      code: 'parada-emergencia',
    });
    const offline = makeSmoke(liveFakeFetch(), { isOnline: () => false });
    await expect(offline.smoke.run({ confirm: true })).rejects.toMatchObject({
      code: 'sin-conexion',
    });
    expect(postCalls()).toHaveLength(0);
  });

  it('sin precio de referencia no hay compra dimensionable', async () => {
    confirmLimits();
    activateMode();
    const { smoke } = makeSmoke(liveFakeFetch(), { referencePrice: () => null });
    await expect(smoke.run({ confirm: true })).rejects.toMatchObject({ code: 'sin-precio' });
    expect(postCalls()).toHaveLength(0);
    expect(persisted()).toBeNull();
  });

  it('con un cierre desfasado no se envía ninguna orden al broker', async () => {
    confirmLimits();
    activateMode();
    // El último cierre guardado es de hace semanas: dimensionar con él
    // movería dinero real con un precio que ya no vale.
    const { smoke } = makeSmoke(liveFakeFetch(), {
      referencePrice: () => ({ price: 500, asOf: '2026-09-20' }),
    });
    await expect(smoke.run({ confirm: true })).rejects.toMatchObject({
      code: 'precio-desfasado',
    });
    expect(postCalls()).toHaveLength(0);
    expect(liveRepo.listOrders()).toHaveLength(0);
    expect(persisted()).toBeNull();
    // Rechazo previo a la red: el modo sigue activo, sin suspensión.
    expect(store.getMode().estado).toBe('activo');
    expect(suspensions).toHaveLength(0);
  });

  it('un límite por orden por debajo de 1 USD bloquea la compra antes de la red', async () => {
    confirmLimits({ ...LIMITS, orderUsd: 0.5 });
    activateMode();
    const { smoke } = makeSmoke();
    await expect(smoke.run({ confirm: true })).rejects.toMatchObject({
      code: 'orden-bloqueada',
    });
    // Nada llegó al broker y el modo sigue activo (no hubo fallo real).
    expect(postCalls()).toHaveLength(0);
    expect(liveRepo.listOrders()).toHaveLength(0);
    expect(store.getMode().estado).toBe('activo');
    expect(suspensions).toHaveLength(0);
    expect(journal.some((j) => j.type === 'limite' && j.reason.includes('bloqueada'))).toBe(true);
  });

  it('la confirmación explícita es obligatoria', async () => {
    confirmLimits();
    activateMode();
    const { smoke } = makeSmoke();
    await expect(smoke.run({ confirm: false as never })).rejects.toMatchObject({
      name: 'LiveSmokeError',
    });
    expect(postCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Flujo completo contra el servidor falso live
// ---------------------------------------------------------------------------

describe('live:smoke-test — flujo completo', () => {
  it('compra 1 USD de SPY, cierra y concilia sin descuadres', async () => {
    confirmLimits();
    activateMode();
    const { smoke } = makeSmoke();

    const result = await smoke.run({ confirm: true });

    expect(result.state).toBe('cerrada-conciliada');
    expect(result.ticker).toBe(LIVE_SMOKE_TICKER);
    expect(result.notionalUsd).toBe(LIVE_SMOKE_NOTIONAL_USD);
    expect(result.steps.every((s) => s.at !== null)).toBe(true);
    // La compra salió limitada con tope: referencia × (1 + 300 pb) = 515.
    expect(result.requestedPrice).toBe(515);
    expect(result.buyExecutedPrice).toBe(500);
    expect(result.sellExecutedPrice).toBe(500);
    expect(result.slippageBps).toBe(0);
    expect(result.reconcileRunId).toEqual(expect.any(Number));
    expect(result.discrepancies).toBe(0);
    expect(result.failedStep).toBeNull();
    expect(result.error).toBeNull();
    expect(result.startedAt).not.toBeNull();
    expect(result.finishedAt).not.toBeNull();

    // Las dos órdenes quedaron en broker_orders_live, ejecutadas y planas.
    const orders = liveRepo.listOrders();
    expect(orders).toHaveLength(2);
    const buy = orders.find((o) => o.side === 'buy')!;
    const sell = orders.find((o) => o.side === 'sell')!;
    expect(buy.clientOrderId).toMatch(/^tradia-humo-\d+-compra$/);
    expect(buy.status).toBe('ejecutada');
    expect(buy.quantity).toBeCloseTo(0.002, 6);
    expect(buy.execution.requestedPrice).toBe(500);
    expect(sell.clientOrderId).toMatch(/^tradia-humo-\d+-cierre$/);
    expect(sell.status).toBe('ejecutada');
    expect(positionsFromOrders(orders)).toHaveLength(0);
    // Nada cayó en la tabla paper.
    expect(createBrokerRepository(db).listOrders()).toHaveLength(0);

    // El resultado persistido coincide y el aviso salió.
    expect(persisted()).toMatchObject({ state: 'cerrada-conciliada' });
    expect(emits).toBeGreaterThan(0);
    expect(suspensions).toHaveLength(0);

    // El Diario lleva el paso a paso y el resumen con los precios.
    expect(
      journal.filter((j) => j.type === 'resumen' && j.reason.includes('Prueba de humo')),
    ).toHaveLength(2);
    const cierre = journal.find((j) => j.type === 'operacion');
    expect(cierre).toBeDefined();
    expect(cierre!.result).toBe('empate');
    expect(cierre!.dataUsed).toMatchObject({
      precioReferencia: 500,
      precioEjecutadoCompra: 500,
      precioEjecutadoCierre: 500,
      slippageBps: 0,
      descuadres: 0,
    });
    // Dinero real: nunca «Operación simulada».
    expect(cierre!.mode).toBe('live');
  });

  it('todas las entradas del Diario de la prueba van marcadas como dinero real', async () => {
    confirmLimits();
    activateMode();
    const { smoke } = makeSmoke();

    await smoke.run({ confirm: true });

    // Compra, cierre, 'operacion' final y cualquier traza de la
    // conciliación live: todas llevan el modo real persistido.
    expect(journal.length).toBeGreaterThan(0);
    expect(journal.every((j) => j.mode === 'live')).toBe(true);
    // La entrada 'operacion' es la que el Diario rotulaba «simulada».
    expect(journal.filter((j) => j.type === 'operacion').every((j) => j.mode === 'live')).toBe(
      true,
    );
  });

  it('registra precio pedido (referencia), ejecutado y slippage con signo', async () => {
    confirmLimits();
    activateMode();
    // El falso ejecuta a 501 mientras la referencia era 500: +20 pb.
    const { smoke } = makeSmoke(
      createAlpacaLiveFakeFetch({ now: () => nowMs, prices: { SPY: 501 }, positions: [] }),
    );

    const result = await smoke.run({ confirm: true });

    expect(result.state).toBe('cerrada-conciliada');
    expect(result.buyExecutedPrice).toBe(501);
    expect(result.slippageBps).toBeCloseTo(20, 1);
    const buy = liveRepo.listOrders().find((o) => o.side === 'buy')!;
    expect(buy.execution.requestedPrice).toBe(500);
    expect(buy.execution.executedPrice).toBe(501);
    expect(buy.execution.slippageBps).toBeCloseTo(20, 1);
    expect(journal.some((j) => String(j.reason).includes('slippage +20 pb'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fallos: paso informado + suspensión del modo real
// ---------------------------------------------------------------------------

describe('live:smoke-test — fallos y suspensión', () => {
  it('un rechazo del broker en la compra falla sin posición y suspende', async () => {
    confirmLimits();
    activateMode();
    const adapter = stubAdapter();
    const { smoke } = makeSmoke(liveFakeFetch(), { getAdapter: () => adapter });

    const result = await smoke.run({ confirm: true });

    expect(result.state).toBe('fallida-sin-posicion');
    expect(result.failedStep).toBe('compra-enviada');
    expect(result.error).toContain('rechazo');
    expect(suspensions).toHaveLength(1);
    expect(store.getMode().estado).toBe('suspendido');
    expect(persisted()).toMatchObject({ state: 'fallida-sin-posicion' });
    expect(journal.some((j) => j.type === 'error' && j.reason.includes('compra enviada'))).toBe(
      true,
    );
  });

  it('un cierre fallido informa de la posición abierta que queda', async () => {
    confirmLimits();
    activateMode();
    let calls = 0;
    const adapter = stubAdapter({
      submitOrder: async (request) => {
        calls += 1;
        if (calls === 1) return remoteOf(request);
        throw new BrokerError('server', 'el broker no responde', { adapter: 'stub' });
      },
    });
    const { smoke } = makeSmoke(liveFakeFetch(), { getAdapter: () => adapter });

    const result = await smoke.run({ confirm: true });

    expect(result.state).toBe('fallida-posicion-abierta');
    expect(result.failedStep).toBe('posicion-cerrada');
    expect(result.steps[0]!.at).not.toBeNull();
    expect(result.buyExecutedPrice).toBe(500);
    // La posición sigue abierta según las órdenes registradas.
    expect(positionsFromOrders(liveRepo.listOrders())[0]).toMatchObject({
      ticker: LIVE_SMOKE_TICKER,
    });
    expect(suspensions).toHaveLength(1);
    expect(journal.some((j) => j.reason.includes('posición real abierta'))).toBe(true);
  });

  it('una orden que no ejecuta se intenta cancelar y se informa del paso', async () => {
    confirmLimits();
    activateMode();
    let canceled = 0;
    const adapter = stubAdapter({
      submitOrder: async (request) =>
        remoteOf(request, {
          status: 'enviada',
          filledQuantity: 0,
          filledAt: null,
          filledAvgPrice: null,
        }),
      getOrderByClientId: async (clientOrderId) =>
        remoteOf({ clientOrderId } as BrokerOrderRequest, {
          status: 'enviada',
          filledQuantity: 0,
          filledAt: null,
          filledAvgPrice: null,
        }),
      cancelOrder: async (id) => {
        canceled += 1;
        return remoteOf({ clientOrderId: id } as BrokerOrderRequest, {
          status: 'cancelada',
          filledQuantity: 0,
          filledAt: null,
          filledAvgPrice: null,
        });
      },
    });
    const { smoke } = makeSmoke(liveFakeFetch(), {
      getAdapter: () => adapter,
      fillTimeoutMs: 1_000,
      pollIntervalMs: 100,
      sleep: async () => {
        nowMs += 500;
      },
    });

    const result = await smoke.run({ confirm: true });

    expect(result.state).toBe('fallida-sin-posicion');
    expect(result.failedStep).toBe('compra-enviada');
    // «Compra enviada» sí llegó; lo que falló fue la ejecución.
    expect(result.steps[0]!.at).not.toBeNull();
    expect(result.buyExecutedPrice).toBeNull();
    expect(canceled).toBe(1);
    expect(suspensions).toHaveLength(1);
  });

  it('una conciliación con descuadres marca el paso y suspende', async () => {
    confirmLimits();
    activateMode();
    // El falso con las posiciones del fixture (AAPL/MSFT) descuadra con
    // la app, que tras comprar y vender SPY queda plana.
    const { smoke } = makeSmoke(
      createAlpacaLiveFakeFetch({ now: () => nowMs, prices: { SPY: 500 } }),
    );

    const result = await smoke.run({ confirm: true });

    expect(result.state).toBe('fallida-sin-posicion');
    expect(result.failedStep).toBe('conciliacion-ok');
    expect(result.steps.map((s) => s.at !== null)).toEqual([true, true, false]);
    expect(result.reconcileRunId).toEqual(expect.any(Number));
    expect(result.discrepancies).toBeGreaterThan(0);
    expect(suspensions).toHaveLength(1);
    expect(journal.some((j) => j.reason.includes('conciliación'))).toBe(true);
  });

  it('un slippage absurdo frente a la referencia da la prueba por fallida y suspende', async () => {
    confirmLimits();
    activateMode();
    // El caso real del fallo P7: referencia del cierre a 1.451,93 USD y
    // el broker ejecuta a 250 USD (slippage ≈ −8.278 pb): referencia y
    // broker no cuadran y la prueba no puede salir «verde».
    const { smoke } = makeSmoke(
      createAlpacaLiveFakeFetch({ now: () => nowMs, prices: { SPY: 250 }, positions: [] }),
      { referencePrice: () => ({ price: 1451.93, asOf: '2026-10-08' }) },
    );

    const result = await smoke.run({ confirm: true });

    expect(result.state).toBe('fallida-posicion-abierta');
    expect(result.failedStep).toBe('compra-enviada');
    expect(result.slippageBps).toBeCloseTo(-8278, -1);
    expect(result.error).toContain('slippage');
    // El modo real queda suspendido y el paso fallido en el Diario.
    expect(suspensions).toHaveLength(1);
    expect(suspensions[0]).toContain('compra enviada');
    expect(store.getMode().estado).toBe('suspendido');
    expect(persisted()).toMatchObject({
      state: 'fallida-posicion-abierta',
      failedStep: 'compra-enviada',
    });
    expect(
      journal.some(
        (j) => j.type === 'error' && j.reason.includes('compra enviada'),
      ),
    ).toBe(true);
    // La posición abierta queda a la vista: no se oculta una compra real.
    expect(positionsFromOrders(liveRepo.listOrders())).toHaveLength(1);
  });

  it('un nocional ejecutado por encima del mínimo con margen da la prueba por fallida', async () => {
    confirmLimits();
    activateMode();
    // El broker reporta una ejecución por encima del tope enviado (la
    // compra salió limitada a 515 y el fill llega a 600): 0,002 × 600 =
    // 1,20 USD supera el mínimo con margen (1,05 USD). Referencia y
    // broker no cuadran.
    const adapter = stubAdapter({
      submitOrder: async (request) => remoteOf(request, { filledAvgPrice: 600 }),
    });
    const { smoke } = makeSmoke(liveFakeFetch(), { getAdapter: () => adapter });

    const result = await smoke.run({ confirm: true });

    expect(result.state).toBe('fallida-posicion-abierta');
    expect(result.failedStep).toBe('compra-enviada');
    expect(result.error).toContain('nocional');
    expect(suspensions).toHaveLength(1);
    expect(store.getMode().estado).toBe('suspendido');
  });

  it('una segunda prueba en curso se rechaza sin tocar nada', async () => {
    confirmLimits();
    activateMode();
    const { smoke } = makeSmoke();

    // La segunda llamada llega antes de que la primera ceda el control.
    const first = smoke.run({ confirm: true });
    await expect(smoke.run({ confirm: true })).rejects.toMatchObject({ code: 'en-curso' });
    const result = await first;
    expect(result.state).toBe('cerrada-conciliada');
  });
});
