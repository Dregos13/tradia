/**
 * Servicio de backtest, persistencia, semilla e IPC — Fase 2.
 *
 * `createBacktestService` es el núcleo, con todo lo externo inyectado
 * (repositorios, fuente de datos, broadcast, reloj): las pruebas lo montan
 * con SQLite en memoria y el proveedor simulado, sin Electron.
 * `registerBacktest` lo cablea en la app y registra los canales
 * `backtest:*` y `stress:*` del contrato (`shared/ipc.ts`).
 *
 * Pipeline de `backtest:run` — cada etapa emite `backtest:progress` y cede
 * el hilo con `setImmediate` entre backtests internos para que la interfaz
 * siga respondiendo (requisito del plan: «worker_threads o trozos con
 * setImmediate»; se eligen trozos porque motor y validación son síncronos):
 *
 * 1. `descargando`: velas del universo desde `desde − warmup` hasta
 *    `hasta`, más el benchmark (SPY) para la referencia comprar-y-mantener.
 * 2. División 60/20/20 (`splitTimeline`); el run ejecuta solo
 *    entrenamiento + validación: el tramo de prueba queda intacto y
 *    bloqueado para `backtest:run-final-test`.
 * 3. `backtest` + `metricas`: `runBacktest` + `computeMetrics`.
 * 4. `walk-forward`: ventanas rodantes que optimizan los dos ejes de
 *    sensibilidad en muestra y evalúan fuera de muestra. Misma semántica
 *    que `runWalkForward` de validation.ts pero iterada en trozos para
 *    ceder el hilo entre backtests (hay una prueba de equivalencia).
 * 5. `sensibilidad`: rejilla 2D sobre los dos ejes elegidos (idem
 *    `runSensitivityMap`, troceada por celda).
 * 6. `monte-carlo`: permutación/bootstrap del orden de las operaciones.
 * 7. Avisos: `evaluateOverfitting` + avisos metodológicos permanentes
 *    (sesgo de supervivencia residual, rendimientos pasados, fuente de
 *    datos) y «pocas operaciones» (< 30, criterio del plan).
 * 8. `guardando`: persistencia en `backtest_runs` y métricas resumen en
 *    la ficha (`strategies.setVersionMetrics`, solo runs 'completo').
 *
 * La prueba final (`runFinalTest`) ejecuta el tramo bloqueado una sola
 * vez por versión: si ya está consumida se rechaza sin descargar datos, y
 * el repositorio además lo impide en la escritura (índice único parcial).
 *
 * Semilla del primer arranque: `seedFichas` crea las cuatro fichas
 * clásicas de forma síncrona (la biblioteca las muestra de inmediato) y
 * `seedResults` lanza en segundo plano un backtest y las tres pruebas de
 * estrés por estrategia (idempotente: lo que ya existe no se repite).
 */
import { app, ipcMain } from 'electron';

import type {
  BacktestFinalTestRequest,
  BacktestListQuery,
  BacktestMetricsDto,
  BacktestNotice,
  BacktestProgressEvent,
  BacktestReport,
  BacktestRunConfig,
  BacktestRunRequest,
  BacktestRunSummary,
  BacktestStage,
  BenchmarkDto,
  DataSplitDto,
  EquityPointDto,
  MonteCarloDto,
  SensitivityDto,
  StressRequest,
  StressResultDto,
  WalkForwardDto,
  WalkForwardWindowDto,
} from '../../shared/backtest';
import {
  IPC_CHANNELS,
  IpcValidationError,
  isBacktestFinalTestRequest,
  isBacktestListQuery,
  isBacktestRunId,
  isBacktestRunRequest,
  isE2eEnabled,
  isStressRequest,
} from '../../shared/ipc';
import {
  DEFAULT_STRATEGY_COSTS,
  type Strategy,
  type StrategyCosts,
  type StrategyMetricsSummary,
  type StrategyParameterRange,
} from '../../shared/strategy';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import type { SessionDate } from '../market/providers';
import { TICKER_PATTERN } from '../market/providers/types';
import { createStrategiesRepository, type StrategiesRepository } from '../strategies/repository';
import { runBacktest } from './engine';
import { computeMetrics, type BacktestMetrics } from './metrics';
import {
  BacktestError,
  createBacktestRepository,
  type BacktestRepository,
  type NewBacktestRun,
} from './repository';
import {
  costConfigFromAssumed,
  resolveStressSource,
  runStressTests,
  warmupStartDate,
  type StressDataSource,
} from './stress';
import { CLASSIC_STRATEGIES, type ClassicStrategyDefinition } from './strategies';
import {
  buildWalkForwardWindows,
  evaluateOverfitting,
  expandParamGrid,
  expandRange,
  FinalTestLockedError,
  runFinalTest,
  runMonteCarlo,
  splitTimeline,
  unionDates,
  type ObjectiveMetric,
  type WalkForwardWindowOptions,
} from './validation';
import type { BacktestInput, CostConfig, EngineBar, StrategyParams } from './types';
import { DEFAULT_INITIAL_CASH, DEFAULT_MAX_POSITIONS, DEFAULT_RISK_PER_TRADE } from './types';

// ---------------------------------------------------------------------------
// Constantes del servicio
// ---------------------------------------------------------------------------

/** Sesiones de calentamiento descargadas antes del inicio del run. */
export const DEFAULT_BACKTEST_WARMUP_SESSIONS = 300;
/** El plan pide ≥30 operaciones para que las métricas sean representativas. */
export const MIN_TRADES_FOR_METRICS = 30;
const DEFAULT_MONTE_CARLO_SIMULATIONS = 1000;
const DEFAULT_MONTE_CARLO_SEED = 1;
/** Ventanas walk-forward por defecto (los mismos defaults que validation.ts). */
const DEFAULT_WF_TRAIN_SIZE = 126;
const DEFAULT_WF_TEST_SIZE = 63;
const DEFAULT_SPLIT_RATIOS = { train: 0.6, validation: 0.2, test: 0.2 };

/** Cede el hilo al bucle de eventos: la interfaz sigue respondiendo. */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

export interface BacktestServiceDeps {
  /** Repositorio de runs/estrés/implementaciones (migración 006). */
  runs: BacktestRepository;
  /** Repositorio de fichas versionadas (migración 005). */
  strategies: StrategiesRepository;
  /** Resuelve la fuente de velas: Tiingo si hay clave, si no el simulado. */
  resolveSource: () => Promise<StressDataSource>;
  /** Catálogo de implementaciones ejecutables (def. las 4 clásicas). */
  impls?: readonly ClassicStrategyDefinition[];
  /** Envía `backtest:progress` al renderer (opcional en pruebas). */
  broadcast?: (channel: string, payload: unknown) => void;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?: () => number;
  /** Sesiones de calentamiento antes del inicio (def. 300). */
  warmupSessions?: number;
  /** Benchmark comprar-y-mantener del informe (def. 'SPY'). */
  benchmarkTicker?: string;
  /**
   * Opciones de los bloques pesados para las ejecuciones de la semilla
   * (misma forma que en `BacktestRunRequest`); por defecto la semilla
   * ejecuta el pipeline completo.
   */
  seedRun?: Pick<BacktestRunRequest, 'walkForward' | 'sensitivity' | 'monteCarlo'>;
  logger?: Partial<{
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  }>;
}

export interface BacktestService {
  /** Pipeline completo sobre entrenamiento + validación; persiste el run. */
  run(request: BacktestRunRequest): Promise<BacktestReport>;
  /** Ejecuta el tramo de prueba bloqueado: una vez por versión. */
  runFinalTest(request: BacktestFinalTestRequest): Promise<BacktestReport>;
  /** Ejecuciones guardadas, más recientes primero. */
  listRuns(query?: BacktestListQuery): BacktestRunSummary[];
  /** Informe completo de un run; null si no existe. */
  getRun(id: number): BacktestReport | null;
  /** Pruebas de estrés guardadas de la versión vigente o una concreta. */
  getStress(request: StressRequest): StressResultDto[];
  /** Ejecuta las tres crisis y las guarda en la ficha (UPSERT). */
  runStress(request: StressRequest): Promise<StressResultDto[]>;
  /**
   * Siembra síncrona del primer arranque: crea las fichas de las
   * estrategias clásicas que falten y registra su implementación.
   * Devuelve cuántas fichas se crearon.
   */
  seedFichas(): number;
  /**
   * Semilla en segundo plano: un backtest y las tres pruebas de estrés
   * por cada estrategia clásica que aún no los tenga. Idempotente.
   */
  seedResults(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

/** Configuración resuelta de una ejecución (petición fusionada con la ficha). */
interface ResolvedRunConfig {
  strategy: Strategy;
  impl: ClassicStrategyDefinition;
  params: StrategyParams;
  markets: string[];
  costs: StrategyCosts;
  engineCosts: Partial<CostConfig>;
  initialCash: number;
  riskPerTrade: number;
  maxPositions: number;
  desde: SessionDate;
  hasta: SessionDate;
  warmupSessions: number;
  split: { train: number; validation: number; test: number };
  walkForward: false | (WalkForwardWindowOptions & { objective?: ObjectiveMetric });
  sensitivity: false | { xParam: string; yParam: string };
  monteCarlo: false | { seed: number; simulations: number; method: 'permutation' | 'bootstrap' };
}

/** Mismo día del mes hace `years` años (29 de febrero → 28). */
function yearsBack(date: SessionDate, years: number): SessionDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y - years, m - 1, d));
  if (shifted.getUTCMonth() !== m - 1) shifted.setUTCDate(0);
  return shifted.toISOString().slice(0, 10);
}

/** Los mercados de la ficha que son tickers ejecutables (normalizados). */
function executableMarkets(markets: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const market of markets) {
    const ticker = market.trim().toUpperCase();
    if (TICKER_PATTERN.test(ticker)) seen.add(ticker);
  }
  return [...seen];
}

/** Métricas JSON-safe: ±Infinity se declara con banderas, no como null mudo. */
function toMetricsDto(m: BacktestMetrics): BacktestMetricsDto {
  return {
    totalReturn: m.totalReturn,
    annualizedReturn: m.annualizedReturn,
    maxDrawdown: m.maxDrawdown,
    sharpe: m.sharpe !== null && Number.isFinite(m.sharpe) ? m.sharpe : null,
    sharpeInfinite: m.sharpe === Infinity ? 'positive' : m.sharpe === -Infinity ? 'negative' : null,
    profitFactor:
      m.profitFactor !== null && Number.isFinite(m.profitFactor) ? m.profitFactor : null,
    profitFactorInfinite: m.profitFactor === Infinity,
    winRate: m.winRate,
    expectancy: m.expectancy,
    maxLosingStreak: m.maxLosingStreak,
    tradeCount: m.tradeCount,
    winningTrades: m.winningTrades,
    losingTrades: m.losingTrades,
    grossProfit: m.grossProfit,
    grossLoss: m.grossLoss,
  };
}

/** Resumen que escribe la ficha (`strategies.setVersionMetrics`). */
function toMetricsSummary(m: BacktestMetricsDto): StrategyMetricsSummary {
  return {
    totalReturnPct: (m.totalReturn ?? 0) * 100,
    maxDrawdownPct: (m.maxDrawdown?.pct ?? 0) * 100,
    sharpe: m.sharpe,
    profitFactor: m.profitFactor,
    winRatePct: m.winRate === null ? null : m.winRate * 100,
    expectancy: m.expectancy,
    maxLosingStreak: m.maxLosingStreak,
    trades: m.tradeCount,
  };
}

/** Config almacenada en el run (los valores efectivamente usados). */
function toStoredConfig(
  cfg: ResolvedRunConfig,
  ejecutadoHasta: SessionDate | null,
): BacktestRunConfig {
  return {
    desde: cfg.desde,
    hasta: cfg.hasta,
    ejecutadoHasta,
    markets: cfg.markets,
    initialCash: cfg.initialCash,
    riskPerTrade: cfg.riskPerTrade,
    maxPositions: cfg.maxPositions,
    parameters: cfg.params,
    warmupSessions: cfg.warmupSessions,
    split: cfg.split,
    walkForward: cfg.walkForward === false ? null : cfg.walkForward,
    sensitivity: cfg.sensitivity === false ? null : cfg.sensitivity,
    monteCarlo: cfg.monteCarlo === false ? null : cfg.monteCarlo,
  };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export function createBacktestService(deps: BacktestServiceDeps): BacktestService {
  const { runs, strategies } = deps;
  const impls = deps.impls ?? CLASSIC_STRATEGIES;
  const now = deps.now ?? (() => Date.now());
  const warmupSessions = deps.warmupSessions ?? DEFAULT_BACKTEST_WARMUP_SESSIONS;
  const benchmarkTicker = (deps.benchmarkTicker ?? 'SPY').toUpperCase();
  const logger = deps.logger ?? console;
  let ticketSeq = 0;

  /** Progreso hacia el renderer: etapa, porcentaje, elemento y tiempo. */
  const makeEmitter = (strategyId: number) => {
    const ticket = `bt-${now().toString(36)}-${++ticketSeq}`;
    const started = now();
    const emit = (stage: BacktestStage, percent: number, detail: string | null = null) => {
      const event: BacktestProgressEvent = {
        ticket,
        strategyId,
        stage,
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        detail,
        elapsedMs: Math.max(0, now() - started),
      };
      deps.broadcast?.(IPC_CHANNELS.backtest.progress, event);
    };
    return emit;
  };

  // -- Resolución de la petición ------------------------------------------

  const resolveStrategy = (strategyId: number, version?: number): Strategy => {
    const strategy = strategies.get(strategyId, version);
    if (strategy === null) {
      throw new BacktestError(
        'not-found',
        version === undefined
          ? `no existe la estrategia ${strategyId}`
          : `no existe la versión ${version} de la estrategia ${strategyId}`,
      );
    }
    return strategy;
  };

  const resolveImpl = (strategyId: number): ClassicStrategyDefinition => {
    const key = runs.implementationKey(strategyId);
    const impl = key === null ? undefined : impls.find((entry) => entry.key === key);
    if (impl === undefined) {
      throw new BacktestError(
        'sin-implementacion',
        `la estrategia ${strategyId} no tiene una implementación ejecutable registrada`,
      );
    }
    return impl;
  };

  /**
   * Los dos ejes del análisis (walk-forward y sensibilidad comparten la
   * elección): los pedidos explícitamente o los dos primeros parámetros
   * con rango de la ficha. Menos de dos ejes → sin sensibilidad, y el
   * walk-forward optimiza solo lo que haya.
   */
  const resolveAxes = (
    strategy: Strategy,
    request: BacktestRunRequest,
  ): { xParam: string; yParam: string } | null => {
    const ranges = strategy.parameterRanges;
    const wanted = request.sensitivity === false ? {} : (request.sensitivity ?? {});
    const xParam = wanted.xParam;
    const yParam = wanted.yParam;
    if (xParam !== undefined || yParam !== undefined) {
      if (xParam === undefined || yParam === undefined) {
        throw new BacktestError(
          'invalid-input',
          'el mapa de sensibilidad necesita los dos ejes (xParam e yParam)',
        );
      }
      if (xParam === yParam) {
        throw new BacktestError('invalid-input', 'los ejes repiten el mismo parámetro');
      }
      if (!(xParam in ranges) || !(yParam in ranges)) {
        throw new BacktestError(
          'invalid-input',
          `los ejes (${xParam}, ${yParam}) necesitan rango en 'parameterRanges' de la ficha`,
        );
      }
      return { xParam, yParam };
    }
    const keys = Object.keys(ranges);
    if (keys.length < 2) return null;
    return { xParam: keys[0]!, yParam: keys[1]! };
  };

  const resolveConfig = (request: BacktestRunRequest): ResolvedRunConfig => {
    const strategy = resolveStrategy(request.strategyId, request.version);
    const impl = resolveImpl(request.strategyId);
    const params: StrategyParams = { ...strategy.parameters, ...request.params };
    const markets = request.universe
      ? executableMarkets(request.universe)
      : executableMarkets(strategy.markets);
    if (markets.length === 0) {
      throw new BacktestError(
        'sin-datos',
        'la ficha no tiene mercados ejecutables (ningún ticker válido)',
      );
    }
    const costs: StrategyCosts = {
      ...DEFAULT_STRATEGY_COSTS,
      ...strategy.assumedCosts,
      ...request.costs,
    };
    const today = new Date(now()).toISOString().slice(0, 10);
    const hasta = request.hasta ?? strategy.outOfSamplePeriod?.hasta ?? today;
    const desde = request.desde ?? strategy.trainingPeriod?.desde ?? yearsBack(hasta, 5);
    if (desde > hasta) {
      throw new BacktestError('invalid-input', `periodo invertido (${desde} > ${hasta})`);
    }
    const topN = params['topN'];
    const sensitivity =
      request.sensitivity === false ? false : (resolveAxes(strategy, request) ?? false);
    return {
      strategy,
      impl,
      params,
      markets,
      costs,
      engineCosts: costConfigFromAssumed(costs),
      initialCash: request.initialCash ?? DEFAULT_INITIAL_CASH,
      riskPerTrade: request.riskPerTrade ?? DEFAULT_RISK_PER_TRADE,
      maxPositions:
        request.maxPositions ??
        (Number.isInteger(topN) && (topN as number) >= 1
          ? (topN as number)
          : DEFAULT_MAX_POSITIONS),
      desde,
      hasta,
      warmupSessions,
      split: { ...DEFAULT_SPLIT_RATIOS, ...request.split },
      walkForward: request.walkForward === false ? false : { ...(request.walkForward ?? {}) },
      sensitivity,
      monteCarlo:
        request.monteCarlo === false
          ? false
          : {
              seed: request.monteCarlo?.seed ?? DEFAULT_MONTE_CARLO_SEED,
              simulations: request.monteCarlo?.simulations ?? DEFAULT_MONTE_CARLO_SIMULATIONS,
              method: request.monteCarlo?.method ?? 'permutation',
            },
    };
  };

  /** Rejilla de optimización: los rangos de los dos ejes elegidos. */
  const gridForAxes = (cfg: ResolvedRunConfig): Record<string, StrategyParameterRange> => {
    if (cfg.sensitivity === false) return {};
    const ranges = cfg.strategy.parameterRanges;
    const grid: Record<string, StrategyParameterRange> = {};
    for (const param of [cfg.sensitivity.xParam, cfg.sensitivity.yParam]) {
      const range = ranges[param];
      if (range !== undefined) grid[param] = range;
    }
    return grid;
  };

  // -- Datos ----------------------------------------------------------------

  /**
   * Velas del universo desde `warmupStartDate(desde)` hasta `hasta`, con una
   * cesión por ticker. Los mercados sin datos se descartan y se anotan.
   */
  const fetchUniverse = async (
    cfg: ResolvedRunConfig,
    source: StressDataSource,
    emit: (stage: BacktestStage, pct: number, detail?: string | null) => void,
  ): Promise<{ bars: Record<string, EngineBar[]>; missing: string[] }> => {
    const warmupDesde = warmupStartDate(cfg.desde, cfg.warmupSessions);
    const bars: Record<string, EngineBar[]> = {};
    const missing: string[] = [];
    for (const [index, ticker] of cfg.markets.entries()) {
      emit('descargando', (index / cfg.markets.length) * 15, ticker);
      const fetched = await source.getBars(ticker, warmupDesde, cfg.hasta);
      if (fetched.length > 0) bars[ticker] = fetched;
      else missing.push(ticker);
      await yieldToEventLoop();
    }
    if (Object.keys(bars).length === 0) {
      throw new BacktestError(
        'sin-datos',
        `la fuente '${source.id}' no devolvió velas para el universo pedido`,
      );
    }
    return { bars, missing };
  };

  /** Entrada del motor con los parámetros dados (el resto sale de la config). */
  const engineInput = (
    cfg: ResolvedRunConfig,
    bars: Record<string, readonly EngineBar[]>,
    params: StrategyParams,
    startDate: SessionDate,
    endDate: SessionDate,
  ): BacktestInput => ({
    strategy: cfg.impl.create(),
    params,
    bars,
    universe: cfg.markets.map((ticker) => ({ ticker })),
    initialCash: cfg.initialCash,
    costs: cfg.engineCosts,
    riskPerTrade: cfg.riskPerTrade,
    maxPositions: cfg.maxPositions,
    startDate,
    endDate,
  });

  const runAndMeasure = (
    cfg: ResolvedRunConfig,
    bars: Record<string, readonly EngineBar[]>,
    params: StrategyParams,
    range: { startDate: SessionDate; endDate: SessionDate },
  ) => {
    const result = runBacktest(engineInput(cfg, bars, params, range.startDate, range.endDate));
    return { result, metrics: computeMetrics(result.equityCurve, result.trades) };
  };

  /** Valida cada candidato sin ejecutar velas ni ocultar errores del motor. */
  const validCandidate = (cfg: ResolvedRunConfig, params: StrategyParams): boolean => {
    try {
      cfg.impl.create().init(params);
      return true;
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
  };

  /** Fechas operativas dentro de [desde, hasta] (sin calentamiento). */
  const operativeDates = (
    bars: Record<string, readonly EngineBar[]>,
    desde: SessionDate,
    hasta: SessionDate,
  ): SessionDate[] => {
    const clipped: Record<string, readonly EngineBar[]> = {};
    for (const [ticker, series] of Object.entries(bars)) {
      clipped[ticker] = series.filter((b) => b.date >= desde && b.date <= hasta);
    }
    return unionDates(clipped);
  };

  // -- Bloques troceados (misma semántica que validation.ts, cediendo el hilo) --

  /**
   * Walk-forward ventana a ventana sobre [desde, oosHasta]: por cada una se
   * evalúa la rejilla de los dos ejes en el tramo de entrenamiento, se elige
   * la mejor métrica objetivo (empate → primera combinación) y se evalúa en
   * la ventana fuera de muestra siguiente. Equivalente a `runWalkForward`
   * con cesiones entre backtests para no bloquear el proceso principal.
   */
  const walkForwardChunked = async (
    cfg: ResolvedRunConfig,
    bars: Record<string, readonly EngineBar[]>,
    dates: readonly SessionDate[],
    emit: (stage: BacktestStage, pct: number, detail?: string | null) => void,
    progressBase: number,
    progressSpan: number,
  ): Promise<WalkForwardDto> => {
    const opts: WalkForwardWindowOptions & { objective?: ObjectiveMetric } =
      cfg.walkForward === false ? {} : cfg.walkForward;
    const windows = buildWalkForwardWindows(dates, opts);
    const objective: ObjectiveMetric = opts.objective ?? 'sharpe';
    const candidates = expandParamGrid(cfg.params, gridForAxes(cfg)).filter((params) =>
      validCandidate(cfg, params),
    );
    if (candidates.length === 0) {
      throw new RangeError('La rejilla no contiene combinaciones válidas para la estrategia.');
    }
    const results: WalkForwardWindowDto[] = [];
    let outOfSampleTrades = 0;

    for (const [index, window] of windows.entries()) {
      let bestParams: StrategyParams = candidates[0]!;
      let bestValue = Number.NEGATIVE_INFINITY;
      let bestMetrics: BacktestMetrics | null = null;
      for (const params of candidates) {
        const { metrics } = runAndMeasure(cfg, bars, params, window.train);
        const value = metrics[objective] ?? Number.NEGATIVE_INFINITY;
        if (bestMetrics === null || value > bestValue) {
          bestValue = value;
          bestParams = params;
          bestMetrics = metrics;
        }
        emit(
          'walk-forward',
          progressBase + ((index + 0.5) / windows.length) * progressSpan,
          `ventana ${index + 1}/${windows.length}`,
        );
        await yieldToEventLoop();
      }
      const test = runAndMeasure(cfg, bars, bestParams, window.test);
      outOfSampleTrades += test.metrics.tradeCount;
      results.push({
        index: window.index,
        train: { ...window.train },
        test: { ...window.test },
        params: bestParams,
        inSampleMetric: bestValue === Number.NEGATIVE_INFINITY ? null : bestValue,
        inSampleMetrics: toMetricsDto(bestMetrics!),
        outOfSampleMetric: test.metrics[objective],
        outOfSampleMetrics: toMetricsDto(test.metrics),
        candidates: candidates.length,
      });
      await yieldToEventLoop();
    }

    const mean = (values: (number | null)[]): number | null => {
      const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
      return finite.length === 0 ? null : finite.reduce((a, b) => a + b, 0) / finite.length;
    };
    return {
      objective,
      trainSize: opts.trainSize ?? DEFAULT_WF_TRAIN_SIZE,
      testSize: opts.testSize ?? DEFAULT_WF_TEST_SIZE,
      step: opts.step ?? opts.testSize ?? DEFAULT_WF_TEST_SIZE,
      windows: results,
      meanInSampleMetric: mean(results.map((w) => w.inSampleMetric)),
      meanOutOfSampleMetric: mean(results.map((w) => w.outOfSampleMetric)),
      outOfSampleTrades,
    };
  };

  /**
   * Rejilla 2D de sensibilidad sobre los dos ejes elegidos: un backtest por
   * celda sobre [desde, hastaEjecutado]. Equivalente a `runSensitivityMap`
   * con cesiones entre celdas.
   */
  const sensitivityChunked = async (
    cfg: ResolvedRunConfig,
    bars: Record<string, readonly EngineBar[]>,
    range: { startDate: SessionDate; endDate: SessionDate },
    emit: (stage: BacktestStage, pct: number, detail?: string | null) => void,
    progressBase: number,
    progressSpan: number,
  ): Promise<SensitivityDto | null> => {
    if (cfg.sensitivity === false) return null;
    const { xParam, yParam } = cfg.sensitivity;
    const ranges = cfg.strategy.parameterRanges;
    const xValues = expandRange(ranges[xParam]!);
    const yValues = expandRange(ranges[yParam]!);
    const metric: ObjectiveMetric = 'sharpe';
    const total = xValues.length * yValues.length;
    const cells: (number | null)[][] = [];
    let done = 0;
    for (const y of yValues) {
      const row: (number | null)[] = [];
      for (const x of xValues) {
        const params = { ...cfg.params, [xParam]: x, [yParam]: y };
        const value = validCandidate(cfg, params)
          ? runAndMeasure(cfg, bars, params, range).metrics[metric]
          : null;
        row.push(value !== null && Number.isFinite(value) ? value : null);
        done += 1;
        emit('sensibilidad', progressBase + (done / total) * progressSpan, `${xParam}=${x}`);
        await yieldToEventLoop();
      }
      cells.push(row);
    }
    const nearest = (values: readonly number[], target: number | undefined): number => {
      if (target === undefined || !Number.isFinite(target)) return Math.floor(values.length / 2);
      let best = 0;
      for (let i = 1; i < values.length; i++) {
        if (Math.abs(values[i]! - target) < Math.abs(values[best]! - target)) best = i;
      }
      return best;
    };
    const baseCell = {
      x: nearest(xValues, cfg.params[xParam]),
      y: nearest(yValues, cfg.params[yParam]),
    };
    return {
      metric,
      xParam,
      xValues,
      yParam,
      yValues,
      cells,
      baseCell,
      baseValue: cells[baseCell.y]?.[baseCell.x] ?? null,
    };
  };

  /** Benchmark comprar-y-mantener sobre el tramo ejecutado. */
  const benchmarkCurve = async (
    cfg: ResolvedRunConfig,
    source: StressDataSource,
    existing: Record<string, readonly EngineBar[]>,
    desde: SessionDate,
    hasta: SessionDate,
  ): Promise<BenchmarkDto | null> => {
    const bars = existing[benchmarkTicker] ?? (await source.getBars(benchmarkTicker, desde, hasta));
    const inside = bars.filter((b) => b.date >= desde && b.date <= hasta);
    if (inside.length === 0) return null;
    const first = inside[0]!.close;
    if (first <= 0) return null;
    const curve: EquityPointDto[] = inside.map((b) => ({
      date: b.date,
      cash: cfg.initialCash,
      equity: (cfg.initialCash * b.close) / first,
      positions: 1,
    }));
    return {
      ticker: benchmarkTicker,
      totalReturn: inside.at(-1)!.close / first - 1,
      curve,
    };
  };

  // -- Avisos del informe -----------------------------------------------------

  const buildWarnings = (
    source: StressDataSource,
    metrics: BacktestMetricsDto,
    sens: SensitivityDto | null,
    mc: MonteCarloDto | null,
    inSampleSharpe: number | null,
    outOfSampleSharpe: number | null,
    missing: string[],
  ): BacktestNotice[] => {
    const warnings: BacktestNotice[] = [];
    for (const warning of evaluateOverfitting({
      inSampleSharpe,
      outOfSampleSharpe,
      sensitivity:
        sens === null
          ? null
          : {
              metric: sens.metric,
              xParam: sens.xParam,
              xValues: sens.xValues,
              yParam: sens.yParam,
              yValues: sens.yValues,
              cells: sens.cells,
              baseCell: sens.baseCell,
              baseValue: sens.baseValue,
            },
      monteCarlo: mc,
    })) {
      warnings.push({ rule: warning.rule, severity: 'critical', message: warning.message });
    }
    if (metrics.tradeCount > 0 && metrics.tradeCount < MIN_TRADES_FOR_METRICS) {
      warnings.push({
        rule: 'pocas-operaciones',
        severity: 'method',
        message:
          `El run cerró ${metrics.tradeCount} operaciones; el plan pide al menos ` +
          `${MIN_TRADES_FOR_METRICS} para que las métricas sean representativas.`,
      });
    }
    if (missing.length > 0) {
      warnings.push({
        rule: 'mercados-sin-datos',
        severity: 'method',
        message: `Sin datos para ${missing.join(', ')}; se excluyeron del universo ejecutado.`,
      });
    }
    warnings.push({
      rule: 'sesgo-supervivencia',
      severity: 'method',
      message:
        'Sesgo de supervivencia residual: el universo del run no registra altas ni bajas ' +
        'históricas; los activos que desaparecieron del mercado no están representados.',
    });
    warnings.push({
      rule: 'rendimientos-pasados',
      severity: 'method',
      message:
        'Los rendimientos pasados no garantizan resultados futuros; este informe es una ' +
        'evaluación estadística del pasado, no una promesa.',
    });
    warnings.push({
      rule: source.kind === 'simulated' ? 'datos-simulados' : 'datos-reales',
      severity: 'info',
      message:
        source.kind === 'simulated'
          ? `Datos simulados (proveedor '${source.id}'): guarda una clave de Tiingo para repetir el análisis con datos reales.`
          : `Datos reales del proveedor '${source.id}'.`,
    });
    return warnings;
  };

  // -- Persistencia -----------------------------------------------------------

  const persistRun = (run: NewBacktestRun): BacktestReport => {
    const id = runs.saveRun(run);
    if (run.kind === 'completo') {
      strategies.setVersionMetrics(run.strategyId, toMetricsSummary(run.metrics), run.version);
    }
    const report = runs.getRun(id);
    if (report === null) {
      throw new BacktestError('not-found', 'no se pudo releer el run recién guardado');
    }
    return report;
  };

  // -- Pipeline principal -----------------------------------------------------

  const runPipeline = async (request: BacktestRunRequest): Promise<BacktestReport> => {
    const started = now();
    const cfg = resolveConfig(request);
    const emit = makeEmitter(cfg.strategy.id);

    try {
      emit('descargando', 0);
      const source = await deps.resolveSource();
      const { bars, missing } = await fetchUniverse(cfg, source, emit);

      // División: el tramo de prueba queda bloqueado, sin ejecutar.
      const dates = operativeDates(bars, cfg.desde, cfg.hasta);
      if (dates.length < 3) {
        throw new BacktestError(
          'sin-datos',
          `solo ${dates.length} sesiones en [${cfg.desde}, ${cfg.hasta}]; se necesitan al menos 3`,
        );
      }
      const split = splitTimeline(dates, cfg.split);
      const ejecutadoHasta = split.validation.endDate;

      emit('backtest', 18);
      const main = runAndMeasure(cfg, bars, cfg.params, {
        startDate: cfg.desde,
        endDate: ejecutadoHasta,
      });
      await yieldToEventLoop();

      emit('metricas', 30);
      const metrics = toMetricsDto(main.metrics);

      // Sharpe por segmento: alimenta la regla «Sharpe OOS < 50 % IS»
      // cuando el walk-forward no aporta medias (u objetivo ≠ sharpe).
      const trainMetrics = runAndMeasure(cfg, bars, cfg.params, split.train).metrics;
      const valMetrics = runAndMeasure(cfg, bars, cfg.params, split.validation).metrics;
      await yieldToEventLoop();

      const benchmark = await benchmarkCurve(cfg, source, bars, cfg.desde, ejecutadoHasta);

      const wfDates = dates.filter((d) => d <= ejecutadoHasta);
      const wf =
        cfg.walkForward === false
          ? null
          : await walkForwardChunked(cfg, bars, wfDates, emit, 32, 30);
      const sens =
        cfg.sensitivity === false
          ? null
          : await sensitivityChunked(
              cfg,
              bars,
              { startDate: cfg.desde, endDate: ejecutadoHasta },
              emit,
              62,
              22,
            );
      let mc: MonteCarloDto | null = null;
      if (cfg.monteCarlo !== false) {
        emit('monte-carlo', 86);
        mc = runMonteCarlo({
          trades: main.result.trades,
          initialCash: cfg.initialCash,
          seed: cfg.monteCarlo.seed,
          simulations: cfg.monteCarlo.simulations,
          method: cfg.monteCarlo.method,
        });
        await yieldToEventLoop();
      }

      const inSampleSharpe =
        (wf !== null && wf.objective === 'sharpe' ? wf.meanInSampleMetric : null) ??
        trainMetrics.sharpe;
      const outOfSampleSharpe =
        (wf !== null && wf.objective === 'sharpe' ? wf.meanOutOfSampleMetric : null) ??
        valMetrics.sharpe;

      emit('guardando', 94);
      const report = persistRun({
        strategyId: cfg.strategy.id,
        version: cfg.strategy.version,
        kind: 'completo',
        config: toStoredConfig(cfg, ejecutadoHasta),
        costs: cfg.costs,
        split: split as DataSplitDto,
        metrics,
        equityCurve: main.result.equityCurve,
        trades: main.result.trades,
        walkForward: wf,
        sensitivity: sens,
        monteCarlo: mc,
        benchmark,
        warnings: buildWarnings(
          source,
          metrics,
          sens,
          mc,
          inSampleSharpe,
          outOfSampleSharpe,
          missing,
        ),
        dataSource: source.kind,
        providerId: source.id,
        durationMs: now() - started,
      });
      emit('completado', 100);
      return report;
    } catch (error: unknown) {
      emit('error', 100, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  // -- Prueba final bloqueada --------------------------------------------------

  const runFinalTestPipeline = async (
    request: BacktestFinalTestRequest,
  ): Promise<BacktestReport> => {
    const started = now();
    const strategy = resolveStrategy(request.strategyId, request.version);
    const emit = makeEmitter(strategy.id);

    const previous = runs.finalTestState(strategy.id, strategy.version);
    if (previous.status === 'ejecutada') {
      // Rechazo barato: ni siquiera se descargan datos.
      throw new FinalTestLockedError(
        `la prueba final ya se ejecutó para la estrategia ${strategy.id} v${strategy.version}; ` +
          'repetirla exige crear una versión nueva',
      );
    }

    try {
      emit('descargando', 0);
      // Si hay un run 'completo' previo se reutiliza su configuración para
      // que la prueba final se ejecute sobre la misma división de datos.
      const reference = runs.latestRun(strategy.id, strategy.version, 'completo');
      const cfg = resolveConfig({ strategyId: strategy.id, version: strategy.version });
      if (reference !== null) {
        cfg.desde = reference.config.desde;
        cfg.hasta = reference.config.hasta;
      }

      const source = await deps.resolveSource();
      const { bars, missing } = await fetchUniverse(cfg, source, emit);
      const dates = operativeDates(bars, cfg.desde, cfg.hasta);
      if (reference === null && dates.length < 3) {
        throw new BacktestError(
          'sin-datos',
          `solo ${dates.length} sesiones en [${cfg.desde}, ${cfg.hasta}]; se necesitan al menos 3`,
        );
      }
      const split = reference?.split ?? splitTimeline(dates, cfg.split);

      emit('backtest', 40, `prueba ${split.test.startDate} → ${split.test.endDate}`);
      const testInput = engineInput(
        cfg,
        bars,
        reference?.config.parameters ?? cfg.params,
        split.test.startDate,
        split.test.endDate,
      );
      const executed = runFinalTest({ ...testInput, alreadyExecuted: false });
      const metrics = toMetricsDto(executed.metrics);
      await yieldToEventLoop();

      const warnings: BacktestNotice[] = [
        {
          rule: 'rendimientos-pasados',
          severity: 'method',
          message:
            'Los rendimientos pasados no garantizan resultados futuros; la prueba final ' +
            'se ejecuta una sola vez por versión y no puede repetirse.',
        },
        {
          rule: source.kind === 'simulated' ? 'datos-simulados' : 'datos-reales',
          severity: 'info',
          message:
            source.kind === 'simulated'
              ? `Datos simulados (proveedor '${source.id}').`
              : `Datos reales del proveedor '${source.id}'.`,
        },
      ];
      if (missing.length > 0) {
        warnings.push({
          rule: 'mercados-sin-datos',
          severity: 'method',
          message: `Sin datos para ${missing.join(', ')}; se excluyeron del universo ejecutado.`,
        });
      }

      emit('guardando', 90);
      const report = persistRun({
        strategyId: strategy.id,
        version: strategy.version,
        kind: 'prueba-final',
        config: toStoredConfig(cfg, split.test.endDate),
        costs: cfg.costs,
        split: split as DataSplitDto,
        metrics,
        equityCurve: executed.result.equityCurve,
        trades: executed.result.trades,
        walkForward: null,
        sensitivity: null,
        monteCarlo: null,
        benchmark: await benchmarkCurve(
          cfg,
          source,
          bars,
          split.test.startDate,
          split.test.endDate,
        ),
        warnings,
        dataSource: source.kind,
        providerId: source.id,
        durationMs: now() - started,
      });
      emit('completado', 100);
      return report;
    } catch (error: unknown) {
      emit('error', 100, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  // -- Pruebas de estrés --------------------------------------------------------

  const runStressPipeline = async (request: StressRequest): Promise<StressResultDto[]> => {
    const strategy = resolveStrategy(request.strategyId, request.version);
    const impl = resolveImpl(strategy.id);
    const markets = executableMarkets(strategy.markets);
    if (markets.length === 0) {
      throw new BacktestError(
        'sin-datos',
        'la ficha no tiene mercados ejecutables (ningún ticker válido)',
      );
    }
    const emit = makeEmitter(strategy.id);
    try {
      emit('estres', 5);
      const source = await deps.resolveSource();
      const topN = strategy.parameters['topN'];
      const result = await runStressTests({
        strategy: impl.create,
        params: strategy.parameters,
        markets,
        source,
        costs: costConfigFromAssumed(strategy.assumedCosts),
        maxPositions:
          Number.isInteger(topN) && (topN as number) >= 1 ? (topN as number) : undefined,
      });
      emit('estres', 90);
      runs.saveStressResults(
        strategy.id,
        strategy.version,
        result.results.map((r) => ({
          crisisId: r.crisis.id,
          crisisName: r.crisis.name,
          desde: r.crisis.desde,
          hasta: r.crisis.hasta,
          sessions: r.sessions,
          totalReturn: r.totalReturn,
          maxDrawdown: r.maxDrawdown,
          trades: r.trades,
          benchmarkTicker: r.benchmarkTicker,
          benchmarkReturn: r.benchmarkReturn,
          dataSource: r.dataSource,
          providerId: r.providerId,
          equityCurve: r.equityCurve,
        })),
      );
      emit('completado', 100);
      return runs.listStress(strategy.id, strategy.version);
    } catch (error: unknown) {
      emit('error', 100, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const getStressRows = (request: StressRequest): StressResultDto[] => {
    const strategy = resolveStrategy(request.strategyId, request.version);
    return runs.listStress(strategy.id, strategy.version);
  };

  // -- Semilla del primer arranque ---------------------------------------------

  const strategyIdForImpl = (implKey: string): number | null => runs.strategyIdForImpl(implKey);

  const service: BacktestService = {
    run: (request) => runPipeline(request),

    runFinalTest: (request) => runFinalTestPipeline(request),

    listRuns: (query = {}) => runs.listRuns(query),

    getRun: (id) => runs.getRun(id),

    getStress: (request) => getStressRows(request),

    runStress: (request) => runStressPipeline(request),

    seedFichas: () => {
      let created = 0;
      for (const impl of impls) {
        if (strategyIdForImpl(impl.key) !== null) continue;
        const strategy = strategies.create(impl.seed);
        runs.setImplementation(strategy.id, impl.key);
        created += 1;
      }
      return created;
    },

    seedResults: async () => {
      for (const impl of impls) {
        const strategyId = strategyIdForImpl(impl.key);
        if (strategyId === null) continue;
        const strategy = strategies.get(strategyId);
        if (strategy === null) continue;
        try {
          if (runs.latestRun(strategyId, strategy.version, 'completo') === null) {
            await runPipeline({
              strategyId,
              version: strategy.version,
              // Evidencia inicial: tres años de entrenamiento y un año OOS.
              // Evita cientos de ventanas trimestrales sobre el histórico de
              // 25 años; la configuración usada queda guardada en el informe.
              walkForward: { trainSize: 756, testSize: 252, step: 252 },
              ...deps.seedRun,
            });
          }
          if (runs.listStress(strategyId, strategy.version).length < 3) {
            await runStressPipeline({ strategyId, version: strategy.version });
          }
        } catch (error: unknown) {
          // La semilla de una estrategia no debe impedir las demás.
          logger.warn?.(
            `[backtest] la semilla de '${impl.key}' falló: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        await yieldToEventLoop();
      }
    },
  };

  return service;
}

// ---------------------------------------------------------------------------
// Registro en la app (handlers IPC + semilla)
// ---------------------------------------------------------------------------

/**
 * Registra los canales `backtest:*` y `stress:*` y lanza la semilla del
 * primer arranque: fichas de forma síncrona (la biblioteca las muestra al
 * instante) y resultados en segundo plano (`seedResults` es idempotente:
 * si el arranque anterior murió a medias, retoma lo que falte).
 * `options.seed` controla la semilla: 'full' (def.) ficha + backtests y
 * estrés en segundo plano; 'fichas' solo crea las fichas; 'none' nada.
 * Los dos últimos existen para pruebas que no quieren trabajo asíncrono.
 */
export function registerBacktest(
  ctx: ServiceContext,
  options: { seed?: 'none' | 'fichas' | 'full' } = {},
): BacktestService {
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[backtest] almacén no disponible: los resultados solo vivirán en memoria');
    db = openDatabase(':memory:');
  }
  const runs = createBacktestRepository(db);
  const strategies = ctx.services.strategies ?? createStrategiesRepository(db);
  const secrets = ctx.services.secrets ?? null;
  const e2e = isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E);

  const service = createBacktestService({
    runs,
    strategies,
    // Misma regla que ingestion.ts/stress.ts: Tiingo si hay clave en
    // secrets; si no, el proveedor simulado (semilla 'tradia-e2e' en las
    // ejecuciones de prueba para reproducibilidad).
    resolveSource: () =>
      resolveStressSource({
        secrets,
        simulated: { seed: e2e ? 'tradia-e2e' : 'tradia' },
      }),
    broadcast: ctx.broadcast,
  });

  ipcMain.handle(IPC_CHANNELS.backtest.run, (_event, request: unknown) => {
    if (!isBacktestRunRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.backtest.run, 'petición de backtest inválida');
    }
    return service.run(request);
  });
  ipcMain.handle(IPC_CHANNELS.backtest.list, (_event, query: unknown) => {
    if (!isBacktestListQuery(query)) {
      throw new IpcValidationError(IPC_CHANNELS.backtest.list, 'filtros inválidos');
    }
    return service.listRuns(query);
  });
  ipcMain.handle(IPC_CHANNELS.backtest.get, (_event, id: unknown) => {
    if (!isBacktestRunId(id)) {
      throw new IpcValidationError(IPC_CHANNELS.backtest.get, 'id de ejecución inválido');
    }
    return service.getRun(id);
  });
  ipcMain.handle(IPC_CHANNELS.backtest.runFinalTest, (_event, request: unknown) => {
    if (!isBacktestFinalTestRequest(request)) {
      throw new IpcValidationError(
        IPC_CHANNELS.backtest.runFinalTest,
        'petición de prueba final inválida',
      );
    }
    return service.runFinalTest(request);
  });
  ipcMain.handle(IPC_CHANNELS.stress.get, (_event, request: unknown) => {
    if (!isStressRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.stress.get, 'consulta de estrés inválida');
    }
    return service.getStress(request);
  });
  ipcMain.handle(IPC_CHANNELS.stress.run, (_event, request: unknown) => {
    if (!isStressRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.stress.run, 'petición de estrés inválida');
    }
    return service.runStress(request);
  });

  // Semilla del primer arranque: fichas síncronas, resultados en segundo
  // plano (con el simulado si no hay clave de Tiingo; en TRADIA_E2E siempre
  // hay datos deterministas).
  const seed = options.seed ?? 'full';
  if (seed !== 'none') {
    service.seedFichas();
    if (seed === 'full') {
      void service.seedResults().catch((error: unknown) => {
        console.error('[backtest] la semilla de resultados falló', error);
      });
    }
  }

  return service;
}
