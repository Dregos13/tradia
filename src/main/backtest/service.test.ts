/**
 * Integración del servicio de backtest: SQLite en memoria (migraciones
 * reales, incluida la 006), proveedor simulado y las cuatro estrategias
 * clásicas. Cubre la semilla del primer arranque, la persistencia del
 * informe completo, el bloqueo de la prueba final y el registro IPC.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase } from '../db/database';
import { createSimulatedProvider, SIMULATED_PROVIDER_ID } from '../market/providers';
import type { CreateStrategyRequest } from '../../shared/strategy';
import {
  IPC_CHANNELS,
  IpcValidationError,
  type BacktestProgressEvent,
} from '../../shared/ipc';
import { createStrategiesRepository, type StrategiesRepository } from '../strategies/repository';
import type { ServiceContext } from '../services';
import type { StorageService } from '../services/storage';
import {
  FinalTestLockedError,
  runSensitivityMap,
  runWalkForward,
  splitTimeline,
  unionDates,
} from './validation';
import { createBacktestRepository, type BacktestRepository } from './repository';
import { createBacktestService, registerBacktest, type BacktestService } from './service';
import {
  costConfigFromAssumed,
  stressSourceFromProvider,
  warmupStartDate,
  type StressDataSource,
} from './stress';
import { CLASSIC_STRATEGIES } from './strategies';
import { DEFAULT_STRATEGY_COSTS } from '../../shared/strategy';

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

interface Harness {
  db: Database.Database;
  strategies: StrategiesRepository;
  runs: BacktestRepository;
  service: BacktestService;
  events: BacktestProgressEvent[];
  source: StressDataSource;
}

/** Monta el servicio real sobre SQLite en memoria y el proveedor simulado. */
const makeService = (
  over: Partial<Parameters<typeof createBacktestService>[0]> = {},
): Harness => {
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

/** Estrategia ejecutable de prueba: implementación 'sma-cross', rangos pequeños. */
const CUSTOM_SEED: CreateStrategyRequest = {
  name: 'Cruce corto de prueba',
  hypothesis: 'La tendencia persiste en el corto plazo.',
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
  regime: 'Cualquiera (prueba)',
};

const createExecutable = (h: Harness, seed: CreateStrategyRequest = CUSTOM_SEED) => {
  const strategy = h.strategies.create(seed);
  h.runs.setImplementation(strategy.id, 'sma-cross');
  return strategy;
};

beforeEach(() => {
  electronMock.handlers.clear();
});

/** StorageService mínimo sobre la base en memoria para registerBacktest. */
const fakeStorage = (db: Database.Database): StorageService => ({
  ready: true,
  dbPath: ':memory:',
  getDb: () => db,
  init: () => Promise.resolve(),
  close: () => undefined,
});

// ---------------------------------------------------------------------------
// Semilla del primer arranque
// ---------------------------------------------------------------------------

describe('semilla de estrategias clásicas', () => {
  it('crea las cuatro fichas en estado investigación sin pisar las existentes', () => {
    const h = makeService();
    const mine = h.strategies.create({ ...CUSTOM_SEED, name: 'Estrategia del usuario' });

    expect(h.service.seedFichas()).toBe(4);
    const list = h.strategies.list();
    expect(list).toHaveLength(5);
    for (const impl of CLASSIC_STRATEGIES) {
      const found = list.find((s) => s.name === impl.seed.name);
      expect(found, `falta la ficha '${impl.seed.name}'`).toBeDefined();
      expect(found!.status).toBe('investigacion');
    }
    // La del usuario queda intacta y la semilla es idempotente.
    expect(list.find((s) => s.id === mine.id)?.name).toBe('Estrategia del usuario');
    expect(h.service.seedFichas()).toBe(0);
  });

  it('guarda un backtest y las tres crisis por estrategia (idempotente)', async () => {
    const h = makeService({
      // Semilla con perfil reducido: los bloques pesados quedan cubiertos
      // por la prueba de run individual.
      seedRun: { walkForward: false, sensitivity: false, monteCarlo: { simulations: 50 } },
    });
    h.service.seedFichas();
    await h.service.seedResults();

    const list = h.strategies.list();
    expect(list).toHaveLength(4);
    for (const summary of list) {
      const runs = h.service.listRuns({ strategyId: summary.id, version: 1 });
      expect(
        runs.filter((r) => r.kind === 'completo'),
        `la estrategia ${summary.id} no tiene backtest semilla`,
      ).toHaveLength(1);

      const stress = h.service.getStress({ strategyId: summary.id });
      expect(stress.map((r) => r.crisisId).sort()).toEqual(['2008', '2020', '2022']);
      for (const row of stress) {
        expect(row.dataSource).toBe('simulated');
        expect(row.providerId).toBe(SIMULATED_PROVIDER_ID);
      }

      // La ficha muestra métricas resumen del run semilla.
      const detail = h.strategies.get(summary.id);
      expect(detail?.metricsSummary).not.toBeNull();
    }

    const before = h.service.listRuns({}).length;
    await h.service.seedResults();
    // Segunda pasada: nada nuevo (ni runs ni crisis duplicadas).
    expect(h.service.listRuns({})).toHaveLength(before);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Ejecución completa de un run
// ---------------------------------------------------------------------------

describe('run completo', () => {
  it('persiste el informe con todos sus bloques y actualiza la ficha', async () => {
    const h = makeService();
    const strategy = createExecutable(h);

    const report = await h.service.run({
      strategyId: strategy.id,
      monteCarlo: { seed: 42, simulations: 200 },
      walkForward: { trainSize: 60, testSize: 30 },
    });

    // Identidad y persistencia.
    expect(report.id).toBeGreaterThan(0);
    expect(report.strategyId).toBe(strategy.id);
    expect(report.version).toBe(1);
    expect(report.kind).toBe('completo');
    expect(report.dataSource).toBe('simulated');
    expect(report.providerId).toBe(SIMULATED_PROVIDER_ID);
    expect(h.service.getRun(report.id)).toEqual(report);
    expect(h.service.listRuns({ strategyId: strategy.id })).toHaveLength(1);

    // Bloques del informe.
    expect(report.metrics.tradeCount).toBeGreaterThanOrEqual(0);
    expect(report.equityCurve.length).toBeGreaterThan(0);
    expect(report.walkForward).not.toBeNull();
    expect(report.walkForward!.windows.length).toBeGreaterThan(0);
    expect(report.sensitivity).not.toBeNull();
    expect(report.sensitivity!.xParam).toBe('fastPeriod');
    expect(report.sensitivity!.cells).toHaveLength(report.sensitivity!.yValues.length);
    expect(report.sensitivity!.cells[0]).toHaveLength(report.sensitivity!.xValues.length);
    expect(report.monteCarlo).not.toBeNull();
    expect(report.monteCarlo!.simulations).toBe(200);
    expect(report.monteCarlo!.seed).toBe(42);
    expect(report.benchmark?.ticker).toBe('SPY');
    expect(report.benchmark!.curve.length).toBeGreaterThan(0);

    // La división existe y el run no ejecuta el tramo de prueba.
    expect(report.split).not.toBeNull();
    expect(report.split!.counts.train).toBeGreaterThan(0);
    expect(report.split!.counts.test).toBeGreaterThan(0);
    expect(report.config.ejecutadoHasta).toBe(report.split!.validation.endDate);
    expect(report.finalTest.status).toBe('disponible');

    // Avisos permanentes: fuente de datos + metodológicos.
    const rules = report.warnings.map((w) => w.rule);
    expect(rules).toContain('datos-simulados');
    expect(rules).toContain('sesgo-supervivencia');
    expect(rules).toContain('rendimientos-pasados');

    // La ficha muestra el resumen de métricas del run.
    const detail = h.strategies.get(strategy.id);
    expect(detail?.metricsSummary?.trades).toBe(report.metrics.tradeCount);
    expect(detail?.metricsSummary?.sharpe).toBe(report.metrics.sharpe);
  }, 60_000);

  it('el walk-forward y la sensibilidad troceados coinciden con validation.ts', async () => {
    const h = makeService();
    const strategy = createExecutable(h);
    const report = await h.service.run({
      strategyId: strategy.id,
      walkForward: { trainSize: 60, testSize: 30 },
      sensitivity: { xParam: 'fastPeriod', yParam: 'slowPeriod' },
      monteCarlo: false,
    });

    // La referencia: los mismos bloques calculados con las funciones
    // síncronas de validation.ts sobre los mismos datos.
    const provider = createSimulatedProvider({ seed: 'svc-test', now: () => NOW });
    const desde = '2020-01-02';
    const hasta = '2024-12-31';
    const spyBars = await provider.getBars('SPY', warmupStartDate(desde, 300), hasta);
    const dates = unionDates({
      SPY: spyBars.filter((b) => b.date >= desde && b.date <= hasta),
    });
    const split = splitTimeline(dates);
    const wfDates = dates.filter((d) => d <= split.validation.endDate);
    const impl = CLASSIC_STRATEGIES.find((c) => c.key === 'sma-cross')!;
    const shared = {
      strategy: impl.create,
      params: CUSTOM_SEED.parameters,
      bars: { SPY: spyBars },
      universe: [{ ticker: 'SPY' }],
      initialCash: 10_000,
      costs: costConfigFromAssumed(DEFAULT_STRATEGY_COSTS),
      riskPerTrade: 0.01,
      maxPositions: 5,
    };

    const wfRef = runWalkForward({
      ...shared,
      dates: wfDates,
      grid: {
        fastPeriod: CUSTOM_SEED.parameterRanges!.fastPeriod!,
        slowPeriod: CUSTOM_SEED.parameterRanges!.slowPeriod!,
      },
      window: { trainSize: 60, testSize: 30 },
    });
    expect(report.walkForward!.windows).toHaveLength(wfRef.windows.length);
    for (const [i, window] of wfRef.windows.entries()) {
      const got = report.walkForward!.windows[i]!;
      expect(got.params).toEqual(window.params);
      expect(got.train).toEqual(window.train);
      expect(got.test).toEqual(window.test);
      expect(got.inSampleMetric).toBe(window.inSampleMetric);
      expect(got.outOfSampleMetric).toBe(window.outOfSampleMetric);
      expect(got.outOfSampleMetrics.tradeCount).toBe(window.outOfSampleMetrics.tradeCount);
    }
    expect(report.walkForward!.meanInSampleMetric).toBe(wfRef.meanInSampleMetric);
    expect(report.walkForward!.meanOutOfSampleMetric).toBe(wfRef.meanOutOfSampleMetric);

    const sensRef = runSensitivityMap({
      ...shared,
      x: { param: 'fastPeriod', range: CUSTOM_SEED.parameterRanges!.fastPeriod! },
      y: { param: 'slowPeriod', range: CUSTOM_SEED.parameterRanges!.slowPeriod! },
      startDate: desde,
      endDate: split.validation.endDate,
    });
    expect(report.sensitivity!.cells).toEqual(sensRef.cells);
    expect(report.sensitivity!.baseCell).toEqual(sensRef.baseCell);
    expect(report.sensitivity!.baseValue).toBe(sensRef.baseValue);
  }, 60_000);

  it('emite progreso por etapas durante la ejecución', async () => {
    const h = makeService();
    const strategy = createExecutable(h);

    await h.service.run({
      strategyId: strategy.id,
      walkForward: false,
      sensitivity: false,
      monteCarlo: false,
    });

    const stages = h.events.map((e) => e.stage);
    expect(stages[0]).toBe('descargando');
    expect(stages).toContain('backtest');
    expect(stages.at(-1)).toBe('completado');
    for (const e of h.events) {
      expect(e.ticket).toMatch(/^bt-/);
      expect(e.strategyId).toBe(strategy.id);
      expect(e.percent).toBeGreaterThanOrEqual(0);
      expect(e.percent).toBeLessThanOrEqual(100);
    }
  }, 60_000);

  it('rechaza estrategia inexistente, sin implementación o sin datos', async () => {
    const h = makeService();
    await expect(h.service.run({ strategyId: 999 })).rejects.toMatchObject({
      name: 'BacktestError',
      code: 'not-found',
    });

    const orphan = h.strategies.create(CUSTOM_SEED);
    await expect(h.service.run({ strategyId: orphan.id })).rejects.toMatchObject({
      code: 'sin-implementacion',
    });

    const noTickers = h.strategies.create({ ...CUSTOM_SEED, markets: ['ETF sectoriales US'] });
    h.runs.setImplementation(noTickers.id, 'sma-cross');
    await expect(h.service.run({ strategyId: noTickers.id })).rejects.toMatchObject({
      code: 'sin-datos',
    });
  });
});

// ---------------------------------------------------------------------------
// Prueba final bloqueada
// ---------------------------------------------------------------------------

describe('prueba final', () => {
  it('se ejecuta una sola vez por versión y se desbloquea en la versión nueva', async () => {
    const h = makeService();
    const strategy = createExecutable(h);
    await h.service.run({
      strategyId: strategy.id,
      walkForward: false,
      sensitivity: false,
      monteCarlo: false,
    });

    const final = await h.service.runFinalTest({ strategyId: strategy.id });
    expect(final.kind).toBe('prueba-final');
    expect(final.split).not.toBeNull();
    expect(final.finalTest.status).toBe('ejecutada');
    expect(final.finalTest.runId).toBe(final.id);
    // El tramo ejecutado coincide con la prueba de la división.
    expect(final.config.ejecutadoHasta).toBe(final.split!.test.endDate);

    // La segunda ejecución para la misma versión se rechaza.
    await expect(h.service.runFinalTest({ strategyId: strategy.id })).rejects.toThrowError(
      FinalTestLockedError,
    );

    // Una versión nueva (v2) tiene su propia prueba final disponible.
    const v2 = h.strategies.update({
      id: strategy.id,
      parameters: { fastPeriod: 6 },
      note: 'Ajuste del periodo rápido',
    });
    expect(v2.version).toBe(2);
    const final2 = await h.service.runFinalTest({ strategyId: strategy.id });
    expect(final2.version).toBe(2);
    expect(final2.kind).toBe('prueba-final');
    expect(
      h.service.listRuns({ strategyId: strategy.id }).filter((r) => r.kind === 'prueba-final'),
    ).toHaveLength(2);
  }, 60_000);

  it('funciona sin run previo: divide el periodo de la ficha', async () => {
    const h = makeService();
    const strategy = createExecutable(h);

    const final = await h.service.runFinalTest({ strategyId: strategy.id });
    expect(final.kind).toBe('prueba-final');
    expect(final.split!.test.startDate >= '2020-01-02').toBe(true);
    await expect(h.service.runFinalTest({ strategyId: strategy.id })).rejects.toThrowError(
      FinalTestLockedError,
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Pruebas de estrés
// ---------------------------------------------------------------------------

describe('pruebas de estrés', () => {
  it('ejecuta y persiste las tres crisis; stress:get las devuelve', async () => {
    const h = makeService();
    const strategy = createExecutable(h);

    const rows = await h.service.runStress({ strategyId: strategy.id });
    expect(rows.map((r) => r.crisisId).sort()).toEqual(['2008', '2020', '2022']);
    for (const row of rows) {
      expect(row.dataSource).toBe('simulated');
      expect(row.sessions).toBeGreaterThanOrEqual(0);
      expect(row.benchmarkTicker).toBe('SPY');
    }
    expect(h.service.getStress({ strategyId: strategy.id })).toEqual(rows);

    // Repetir sobrescribe (UPSERT), no duplica.
    const again = await h.service.runStress({ strategyId: strategy.id });
    expect(again).toHaveLength(3);
    expect(h.service.getStress({ strategyId: strategy.id })).toHaveLength(3);
  }, 60_000);

  it('rechaza estrés sobre estrategia sin implementación ejecutable', async () => {
    const h = makeService();
    const orphan = h.strategies.create(CUSTOM_SEED);
    await expect(h.service.runStress({ strategyId: orphan.id })).rejects.toMatchObject({
      code: 'sin-implementacion',
    });
  });
});

// ---------------------------------------------------------------------------
// Registro IPC
// ---------------------------------------------------------------------------

describe('registro IPC', () => {
  it('registra los canales, valida la entrada y devuelve errores limpios', async () => {
    const db = database();
    const strategies = createStrategiesRepository(db);
    const ctx: ServiceContext = {
      broadcast: () => undefined,
      services: { storage: fakeStorage(db), strategies },
    };

    registerBacktest(ctx, { seed: 'none' });

    for (const channel of [
      IPC_CHANNELS.backtest.run,
      IPC_CHANNELS.backtest.list,
      IPC_CHANNELS.backtest.get,
      IPC_CHANNELS.backtest.runFinalTest,
      IPC_CHANNELS.stress.get,
      IPC_CHANNELS.stress.run,
    ]) {
      expect(electronMock.handlers.has(channel), `falta ${channel}`).toBe(true);
    }

    const run = electronMock.handlers.get(IPC_CHANNELS.backtest.run)!;
    // Los guardas rechazan de forma síncrona; el servicio, de forma asíncrona.
    expect(() => run(null, { strategyId: 'x' })).toThrowError(IpcValidationError);
    await expect(run(null, { strategyId: 999 })).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(() =>
      electronMock.handlers.get(IPC_CHANNELS.backtest.get)!(null, '1'),
    ).toThrowError(IpcValidationError);
    expect(() =>
      electronMock.handlers.get(IPC_CHANNELS.stress.get)!(null, { strategyId: -1 }),
    ).toThrowError(IpcValidationError);
    expect(await electronMock.handlers.get(IPC_CHANNELS.backtest.list)!(null, undefined)).toEqual([]);
  });

  it('siembra las fichas al registrar (seed activado por defecto)', () => {
    const db = database();
    const strategies = createStrategiesRepository(db);
    const ctx: ServiceContext = {
      broadcast: () => undefined,
      services: { storage: fakeStorage(db), strategies },
    };
    // 'fichas': siembra síncrona sin lanzar los backtests de fondo.
    registerBacktest(ctx, { seed: 'fichas' });
    expect(strategies.list()).toHaveLength(4);
  });
});
