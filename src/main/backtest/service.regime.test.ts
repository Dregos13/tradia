/**
 * Comparación emparejada con y sin filtro de régimen — Fase 6.
 *
 * `backtest:run-regime-comparison` ejecuta el par sobre la misma base
 * (periodo, universo, parámetros y costes): el lado sin filtro es el
 * último run 'completo' no filtrado si existe —si no, se corre también—
 * y el lado con filtro siempre se corre con la ficha vigente. La fila de
 * `regime_comparisons` queda consultable por `backtest:regime-comparison`
 * y la semilla del primer arranque la crea para las cuatro clásicas.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase } from '../db/database';
import { createSimulatedProvider, SIMULATED_PROVIDER_ID } from '../market/providers';
import type { CreateStrategyRequest } from '../../shared/strategy';
import { IPC_CHANNELS, IpcValidationError, type BacktestProgressEvent } from '../../shared/ipc';
import { createStrategiesRepository, type StrategiesRepository } from '../strategies/repository';
import type { ServiceContext } from '../services';
import type { StorageService } from '../services/storage';
import { createBacktestRepository, type BacktestRepository } from './repository';
import { createBacktestService, registerBacktest, type BacktestService } from './service';
import { stressSourceFromProvider, type StressDataSource } from './stress';

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electronMock.handlers.set(channel, handler),
  },
  app: { isPackaged: true },
}));

const NOW = Date.parse('2025-06-30T12:00:00.000Z');
const dbs: Database.Database[] = [];

const database = (): Database.Database => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
};

afterEach(() => {
  for (const db of dbs.splice(0)) {
    if (db.open) db.close();
  }
  electronMock.handlers.clear();
});

beforeEach(() => {
  electronMock.handlers.clear();
});

interface Harness {
  db: Database.Database;
  strategies: StrategiesRepository;
  runs: BacktestRepository;
  service: BacktestService;
  events: BacktestProgressEvent[];
  source: StressDataSource;
}

const makeService = (over: Partial<Parameters<typeof createBacktestService>[0]> = {}): Harness => {
  const db = database();
  const strategies = createStrategiesRepository(db);
  const runs = createBacktestRepository(db);
  const source = stressSourceFromProvider(
    createSimulatedProvider({ seed: 'svc-test', now: () => NOW }),
  );
  const events: BacktestProgressEvent[] = [];
  const service = createBacktestService({
    runs,
    strategies,
    resolveSource: async () => source,
    broadcast: (_channel, payload) => events.push(payload as BacktestProgressEvent),
    now: () => NOW,
    logger: { warn: () => undefined, error: () => undefined, info: () => undefined },
    ...over,
  });
  return { db, strategies, runs, service, events, source };
};

/** Ficha ejecutable que declara su régimen: solo funciona en lateral y falla en tendencia. */
const REGIME_SEED: CreateStrategyRequest = {
  name: 'Reversión de prueba',
  hypothesis: 'Los mercados laterales mean-revierten.',
  rules: {
    entry: 'Compra al cruzar la rápida sobre la lenta.',
    exit: 'Vende al cruzar a la baja.',
    stop: 'Stop 3×ATR.',
    target: 'Sin objetivo.',
  },
  parameters: { fastPeriod: 5, slowPeriod: 20, atrPeriod: 14, stopAtr: 3 },
  parameterRanges: {
    fastPeriod: { min: 5, max: 15, step: 5 },
    slowPeriod: { min: 20, max: 40, step: 10 },
  },
  markets: ['SPY'],
  trainingPeriod: { desde: '2020-01-02', hasta: '2022-12-31' },
  outOfSamplePeriod: { desde: '2023-01-02', hasta: '2024-12-31' },
  regime: 'Lateral (prueba)',
  worksIn: ['lateral'],
  failsIn: ['tendencia'],
};

const createExecutable = (h: Harness, seed: CreateStrategyRequest = REGIME_SEED) => {
  const strategy = h.strategies.create(seed);
  h.runs.setImplementation(strategy.id, 'sma-cross');
  return strategy;
};

/** Reglas ejecutables de una ficha propia (cruce de medias en el DSL). */
const DSL_RULES: CreateStrategyRequest['rules'] = {
  entry: 'cruza_arriba(sma(rapida), sma(lenta))',
  exit: 'cruza_abajo(sma(rapida), sma(lenta))',
  stop: 'stopAtr * atr(atrPeriod)',
  target: 'targetR * stopAtr * atr(atrPeriod)',
};

const fakeStorage = (db: Database.Database): StorageService => ({
  ready: true,
  dbPath: ':memory:',
  getDb: () => db,
  init: () => Promise.resolve(),
  close: () => undefined,
});

// ---------------------------------------------------------------------------
// Comparación emparejada
// ---------------------------------------------------------------------------

describe('comparación con y sin filtro de régimen', () => {
  it('reutiliza el último run sin filtro como lado base (mismo periodo y costes)', async () => {
    const h = makeService();
    const strategy = createExecutable(h);
    const base = await h.service.run({
      strategyId: strategy.id,
      walkForward: false,
      sensitivity: false,
      monteCarlo: false,
    });

    const comparison = await h.service.runRegimeComparison({ strategyId: strategy.id });

    expect(comparison.strategyId).toBe(strategy.id);
    expect(comparison.version).toBe(1);
    // El lado sin filtro es exactamente el run previo: misma base garantizada.
    expect(comparison.withoutFilter.runId).toBe(base.id);
    expect(comparison.withFilter.runId).not.toBeNull();
    expect(comparison.withFilter.runId).not.toBe(base.id);
    expect(comparison.period).toEqual({
      desde: base.config.desde,
      hasta: base.config.ejecutadoHasta,
    });
    expect(comparison.markets).toEqual(base.config.markets);
    expect(comparison.comparable).toBe(true);
    // Las cinco métricas del diseño están presentes en ambos lados.
    for (const side of [comparison.withoutFilter, comparison.withFilter]) {
      expect(side.trades).toBeGreaterThanOrEqual(0);
      expect(side.totalReturnPct === null || Number.isFinite(side.totalReturnPct)).toBe(true);
      expect(side.maxDrawdownPct === null || Number.isFinite(side.maxDrawdownPct)).toBe(true);
      expect(side.winRatePct === null || Number.isFinite(side.winRatePct)).toBe(true);
    }

    // El run filtrado queda marcado en su configuración y no toca la ficha.
    const filteredReport = h.service.getRun(comparison.withFilter.runId!)!;
    expect(filteredReport.config.regimeFilter).toBe(true);
    expect(filteredReport.kind).toBe('completo');
    expect(filteredReport.config.desde).toBe(base.config.desde);
    expect(filteredReport.config.ejecutadoHasta).toBe(base.config.ejecutadoHasta);
    expect(filteredReport.warnings.map((w) => w.rule)).toContain('filtro-regimen');
    const detail = h.strategies.get(strategy.id)!;
    expect(detail.metricsSummary?.trades).toBe(base.metrics.tradeCount);
    // La consulta devuelve lo mismo que la ejecución.
    expect(h.service.getRegimeComparison({ strategyId: strategy.id })).toEqual(comparison);
  }, 60_000);

  it('sin run previo ejecuta los dos lados sobre la configuración de la ficha', async () => {
    const h = makeService();
    const strategy = createExecutable(h);

    const comparison = await h.service.runRegimeComparison({ strategyId: strategy.id });

    expect(comparison.withoutFilter.runId).not.toBeNull();
    expect(comparison.withFilter.runId).not.toBeNull();
    expect(comparison.withoutFilter.runId).not.toBe(comparison.withFilter.runId);
    expect(comparison.comparable).toBe(true);
    expect(comparison.period.desde).toBe('2020-01-02');
    expect(comparison.period.hasta < '2024-12-31').toBe(true);
    const without = h.service.getRun(comparison.withoutFilter.runId!)!;
    const withFilter = h.service.getRun(comparison.withFilter.runId!)!;
    expect(without.config.regimeFilter).toBeUndefined();
    expect(withFilter.config.regimeFilter).toBe(true);
    // Mismo tramo ejecutado, universo, parámetros y costes.
    expect(withFilter.config.desde).toBe(without.config.desde);
    expect(withFilter.config.ejecutadoHasta).toBe(without.config.ejecutadoHasta);
    expect(withFilter.config.markets).toEqual(without.config.markets);
    expect(withFilter.config.parameters).toEqual(without.config.parameters);
    expect(withFilter.costs).toEqual(without.costs);
    // El tramo de prueba sigue bloqueado en ambos lados.
    expect(without.config.ejecutadoHasta).toBe(without.split!.validation.endDate);
  }, 60_000);

  it('la segunda ejecución actualiza la fila (UPSERT), no duplica', async () => {
    const h = makeService();
    const strategy = createExecutable(h);
    const first = await h.service.runRegimeComparison({ strategyId: strategy.id });
    const second = await h.service.runRegimeComparison({ strategyId: strategy.id });

    expect(second.withoutFilter.runId).toBe(first.withoutFilter.runId);
    expect(second.withFilter.runId).not.toBe(first.withFilter.runId);
    expect(h.service.getRegimeComparison({ strategyId: strategy.id })).toEqual(second);
    // Solo una fila por versión: la consulta siempre devuelve la última.
    const row = h.runs.getRegimeComparison(strategy.id, 1);
    expect(row?.runConFiltro).toBe(second.withFilter.runId);
  }, 60_000);

  it('marca como no comparable un par que no comparte la misma base', async () => {
    const h = makeService();
    const strategy = createExecutable(h);
    const a = await h.service.run({
      strategyId: strategy.id,
      walkForward: false,
      sensitivity: false,
      monteCarlo: false,
    });
    const b = await h.service.run({
      strategyId: strategy.id,
      desde: '2021-01-04',
      walkForward: false,
      sensitivity: false,
      monteCarlo: false,
    });
    h.runs.saveRegimeComparison(strategy.id, 1, a.id, b.id);

    const comparison = h.service.getRegimeComparison({ strategyId: strategy.id });
    expect(comparison).not.toBeNull();
    expect(comparison!.comparable).toBe(false);
  }, 60_000);

  it('ejecuta el par emparejado de una estrategia propia (reglas DSL)', async () => {
    const h = makeService();
    // Sin clave en strategy_implementations: se compilan las reglas.
    const own = h.strategies.create({
      ...REGIME_SEED,
      rules: DSL_RULES,
      parameters: { rapida: 5, lenta: 20, atrPeriod: 14, stopAtr: 3, targetR: 2.5 },
      parameterRanges: {},
    });

    const comparison = await h.service.runRegimeComparison({ strategyId: own.id });
    expect(comparison.strategyId).toBe(own.id);
    expect(comparison.version).toBe(1);
    expect(comparison.comparable).toBe(true);
    expect(comparison.withoutFilter.runId).not.toBeNull();
    expect(comparison.withFilter.runId).not.toBeNull();
    expect(comparison.withoutFilter.runId).not.toBe(comparison.withFilter.runId);
    const withFilter = h.service.getRun(comparison.withFilter.runId!)!;
    expect(withFilter.config.regimeFilter).toBe(true);
    expect(withFilter.warnings.map((w) => w.rule)).toContain('filtro-regimen');
    expect(h.service.getRegimeComparison({ strategyId: own.id })).toEqual(comparison);
  }, 60_000);

  it('una estrategia propia con reglas que no compilan da reglas-invalidas', async () => {
    const h = makeService();
    const broken = h.strategies.create(REGIME_SEED); // texto libre anterior al DSL
    await expect(h.service.runRegimeComparison({ strategyId: broken.id })).rejects.toMatchObject({
      code: 'reglas-invalidas',
    });
    // Ni runs ni comparación guardados.
    expect(h.service.listRuns({ strategyId: broken.id })).toEqual([]);
    expect(h.service.getRegimeComparison({ strategyId: broken.id })).toBeNull();
  });

  it('rechaza estrategias inexistentes o sin implementación', async () => {
    const h = makeService();
    await expect(h.service.runRegimeComparison({ strategyId: 999 })).rejects.toMatchObject({
      code: 'not-found',
    });
    // Clave registrada que no corresponde a ninguna clásica conocida.
    const orphan = h.strategies.create(REGIME_SEED);
    h.runs.setImplementation(orphan.id, 'clave-inexistente');
    await expect(h.service.runRegimeComparison({ strategyId: orphan.id })).rejects.toMatchObject({
      code: 'sin-implementacion',
    });
    expect(() => h.service.getRegimeComparison({ strategyId: 999 })).toThrowError(/no existe/);
  });
});

// ---------------------------------------------------------------------------
// backtest:run con regimeFilter
// ---------------------------------------------------------------------------

describe('backtest:run con filtro de régimen', () => {
  it('guarda la marca, no toca el resumen de la ficha ni la referencia sin filtro', async () => {
    const h = makeService();
    const strategy = createExecutable(h);

    const filtered = await h.service.run({
      strategyId: strategy.id,
      regimeFilter: true,
      walkForward: false,
      sensitivity: false,
      monteCarlo: false,
    });
    expect(filtered.config.regimeFilter).toBe(true);
    // La ficha no toma métricas de un run filtrado.
    expect(h.strategies.get(strategy.id)!.metricsSummary).toBeNull();
    // La referencia sin filtro no es el run filtrado.
    expect(h.runs.latestRun(strategy.id, 1, 'completo', { regimeFilter: false })).toBeNull();
    // La comparación posterior crea el lado sin filtro y enlaza el nuevo filtrado.
    const comparison = await h.service.runRegimeComparison({ strategyId: strategy.id });
    expect(comparison.comparable).toBe(true);
    expect(comparison.withFilter.runId).not.toBeNull();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Semilla del primer arranque
// ---------------------------------------------------------------------------

describe('semilla del primer arranque', () => {
  it('crea la comparación de las cuatro clásicas consultable por IPC', async () => {
    // seedRun limitado: la comparación no necesita los bloques pesados.
    const h = makeService({
      seedRun: { walkForward: false, sensitivity: false, monteCarlo: false },
    });
    h.service.seedFichas();
    await h.service.seedResults();

    const list = h.strategies.list();
    expect(list).toHaveLength(4);
    for (const summary of list) {
      const comparison = h.service.getRegimeComparison({ strategyId: summary.id });
      expect(comparison, `la semilla ${summary.name} no tiene comparación guardada`).not.toBeNull();
      expect(comparison!.comparable).toBe(true);
      // Mismo periodo y costes en los dos lados (requisito del informe).
      const without = h.service.getRun(comparison!.withoutFilter.runId!)!;
      const withFilter = h.service.getRun(comparison!.withFilter.runId!)!;
      expect(without.config.ejecutadoHasta).toBe(comparison!.period.hasta);
      expect(withFilter.config.ejecutadoHasta).toBe(without.config.ejecutadoHasta);
      expect(withFilter.costs).toEqual(without.costs);
      expect(withFilter.providerId).toBe(SIMULATED_PROVIDER_ID);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Registro IPC
// ---------------------------------------------------------------------------

describe('canales IPC de la comparación', () => {
  it('registra backtest:regime-comparison y backtest:run-regime-comparison con guardas', async () => {
    const db = database();
    const strategies = createStrategiesRepository(db);
    const ctx: ServiceContext = {
      broadcast: () => undefined,
      services: { storage: fakeStorage(db), strategies },
    };
    registerBacktest(ctx, { seed: 'none' });

    const get = electronMock.handlers.get(IPC_CHANNELS.backtest.regimeComparison)!;
    const run = electronMock.handlers.get(IPC_CHANNELS.backtest.runRegimeComparison)!;
    expect(get).toBeDefined();
    expect(run).toBeDefined();

    // Guardas de entrada: rechazo síncrono con error legible.
    expect(() => get(null, { strategyId: 'x' })).toThrowError(IpcValidationError);
    expect(() => run(null, { strategyId: 1, version: 0 })).toThrowError(IpcValidationError);
    expect(() => run(null, { strategyId: 1, desde: '2020-01-01' })).toThrowError(
      IpcValidationError,
    );

    // Sin comparación guardada devuelve null; con ella, el DTO del contrato.
    const strategy = strategies.create(REGIME_SEED);
    createBacktestRepository(db).setImplementation(strategy.id, 'sma-cross');
    expect(await get(null, { strategyId: strategy.id })).toBeNull();
    const comparison = (await run(null, { strategyId: strategy.id })) as {
      comparable: boolean;
      period: { desde: string };
    };
    expect(comparison.comparable).toBe(true);
    expect(comparison.period.desde).toBe('2020-01-02');
    expect(await get(null, { strategyId: strategy.id })).toEqual(comparison);
  }, 60_000);
});
