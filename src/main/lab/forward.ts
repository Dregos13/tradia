/**
 * Prueba en vivo (forward test) del laboratorio.
 *
 * Una prueba congela la versión de la estrategia y fija la fecha de
 * inicio. Su resultado nunca se guarda: se recalcula repitiendo el motor
 * de backtest desde `start_date` hasta la última vela disponible, con
 * `keepOpenAtEnd` para ver la cartera tal como está hoy (posiciones
 * abiertas y órdenes para la próxima apertura). Como el motor no tiene
 * look-ahead y las reglas están congeladas, el resultado es exactamente
 * el que habría dado operar en paper cada cierre desde ese día.
 */
import type Database from 'better-sqlite3';

import { REGIME_MARKET_TICKER } from '../../shared/ai';
import { normalizeFxPair } from '../../shared/fx';
import {
  FORWARD_DEFAULT_CASH,
  type ForwardDetail,
  type ForwardStartRequest,
  type ForwardSummary,
  type ForwardTest,
} from '../../shared/lab';
import { DEFAULT_STRATEGY_COSTS, type Strategy } from '../../shared/strategy';
import { parseStrategyRules } from '../../shared/strategyRules';
import { runBacktest } from '../backtest/engine';
import type { BacktestRepository } from '../backtest/repository';
import type { ClassicStrategyDefinition } from '../backtest/strategies';
import { CLASSIC_STRATEGIES } from '../backtest/strategies';
import { createCustomStrategy } from '../backtest/strategies/custom';
import { costConfigFromAssumed, warmupStartDate, type StressDataSource } from '../backtest/stress';
import type { EngineBar, Strategy as EngineStrategy } from '../backtest/types';
import { warmupCalendarFor } from '../market/assetCalendar';
import { TICKER_PATTERN, type SessionDate } from '../market/providers/types';
import type { StrategiesRepository } from '../strategies/repository';

const WARMUP_SESSIONS = 300;
/** Tiempo que vale un cálculo antes de volver a pedir velas. */
const CACHE_TTL_MS = 15 * 60_000;
const SPARK_POINTS = 40;

export class ForwardError extends Error {
  constructor(
    readonly code: 'not-found' | 'invalid-input' | 'reglas-invalidas',
    message: string,
  ) {
    super(message);
    this.name = 'ForwardError';
  }
}

// ---------------------------------------------------------------------------
// Repositorio
// ---------------------------------------------------------------------------

interface ForwardRow {
  id: number;
  strategy_id: number;
  version: number;
  start_date: string;
  initial_cash: number;
  benchmark: string;
  status: 'activa' | 'detenida';
  stopped_at: string | null;
  created_at: string;
}

export interface ForwardRepository {
  list(): ForwardRow[];
  get(id: number): ForwardRow | null;
  insert(row: Omit<ForwardRow, 'id' | 'status' | 'stopped_at' | 'created_at'>): ForwardRow;
  stop(id: number, at: string): void;
  remove(id: number): void;
}

export function createForwardRepository(db: Database.Database): ForwardRepository {
  const get = (id: number): ForwardRow | null =>
    (db.prepare('SELECT * FROM forward_tests WHERE id = ?').get(id) as ForwardRow | undefined) ??
    null;
  return {
    list: () => db.prepare('SELECT * FROM forward_tests ORDER BY id DESC').all() as ForwardRow[],
    get,
    insert: (row) => {
      const info = db
        .prepare(
          `INSERT INTO forward_tests (strategy_id, version, start_date, initial_cash, benchmark)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(row.strategy_id, row.version, row.start_date, row.initial_cash, row.benchmark);
      return get(Number(info.lastInsertRowid))!;
    },
    stop: (id, at) => {
      db.prepare(
        "UPDATE forward_tests SET status = 'detenida', stopped_at = ? WHERE id = ? AND status = 'activa'",
      ).run(at, id);
    },
    remove: (id) => {
      db.prepare('DELETE FROM forward_tests WHERE id = ?').run(id);
    },
  };
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

export function executableMarkets(markets: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const market of markets) {
    const ticker = normalizeFxPair(market) ?? market.trim().toUpperCase();
    if (TICKER_PATTERN.test(ticker)) seen.add(ticker);
  }
  return [...seen];
}

/** Hora de Nueva York para decidir si la sesión de hoy ya cerró. */
export function nyParts(ms: number): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/**
 * Primera sesión que cuenta: hoy si el mercado de EE. UU. aún no ha
 * cerrado (las reglas se lanzan antes de ver el cierre), mañana si ya
 * cerró — así nunca se aprovecha un cierre que el usuario ya ha visto.
 */
export function forwardStartDate(nowMs: number): string {
  const { date, minutes } = nyParts(nowMs);
  if (minutes < 16 * 60) return date;
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function maxDrawdown(values: readonly number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak);
  }
  return worst;
}

function sample(values: readonly number[], n: number): number[] {
  if (values.length <= n) return [...values];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(values[Math.round((i * (values.length - 1)) / (n - 1))]!);
  return out;
}

export function emptyForwardDetail(
  test: ForwardTest,
  error: string | null,
  kind: 'real' | 'simulated',
): ForwardDetail {
  return {
    test,
    asOf: null,
    sessions: 0,
    equity: test.initialCash,
    returnPct: 0,
    benchmarkReturnPct: null,
    maxDrawdownPct: 0,
    tradeCount: 0,
    winRate: null,
    openPositions: 0,
    spark: [],
    backtestAnnualPct: null,
    dataKind: kind,
    error,
    curve: [],
    trades: [],
    positions: [],
    pendingOrders: [],
  };
}

export interface ComputeForwardInput {
  test: ForwardTest;
  strategy: Strategy;
  create: () => EngineStrategy;
  getBars(ticker: string, desde: SessionDate, hasta: SessionDate): Promise<EngineBar[]>;
  /** Fecha de hoy (Nueva York). */
  today: SessionDate;
  dataKind: 'real' | 'simulated';
  backtestAnnualPct: number | null;
}

/**
 * Repite el motor desde el inicio de la prueba hasta hoy (o hasta el día
 * en que se detuvo) y arma el detalle: curva frente al benchmark,
 * operaciones cerradas, cartera viva y órdenes para la próxima apertura.
 */
export async function computeForward(input: ComputeForwardInput): Promise<ForwardDetail> {
  const { test, strategy, backtestAnnualPct } = input;
  const kind = input.dataKind;
  const markets = test.markets;
  if (markets.length === 0) {
    return {
      ...emptyForwardDetail(test, 'La estrategia no tiene mercados operables.', kind),
      backtestAnnualPct,
    };
  }
  const endDate =
    test.status === 'detenida' && test.stoppedAt ? test.stoppedAt.slice(0, 10) : input.today;
  // Lanzada después del cierre: aún no ha llegado su primera sesión.
  if (test.startDate > endDate) {
    return { ...emptyForwardDetail(test, null, kind), backtestAnnualPct };
  }
  const fromDate = warmupStartDate(
    test.startDate,
    WARMUP_SESSIONS,
    warmupCalendarFor(markets).isSessionDay,
  );
  const bars: Record<string, EngineBar[]> = {};
  for (const ticker of markets) {
    const fetched = await input.getBars(ticker, fromDate, endDate);
    if (fetched.length > 0) bars[ticker] = fetched;
  }
  const benchmarkBars =
    bars[test.benchmark] ?? (await input.getBars(test.benchmark, test.startDate, endDate));
  const needsRef = strategy.worksIn.length > 0 || strategy.failsIn.length > 0;
  if (needsRef && !(REGIME_MARKET_TICKER in bars)) {
    const ref = await input.getBars(REGIME_MARKET_TICKER, fromDate, endDate);
    if (ref.length > 0) bars[REGIME_MARKET_TICKER] = ref;
  }
  if (Object.keys(bars).length === 0) {
    return {
      ...emptyForwardDetail(test, 'Sin velas para los mercados de la estrategia.', kind),
      backtestAnnualPct,
    };
  }

  const costs = { ...DEFAULT_STRATEGY_COSTS, ...strategy.assumedCosts };
  const topN = strategy.parameters['topN'];
  const result = runBacktest({
    strategy: input.create(),
    params: strategy.parameters,
    bars,
    universe: markets.filter((t) => t in bars).map((ticker) => ({ ticker })),
    initialCash: test.initialCash,
    costs: costConfigFromAssumed(costs),
    maxPositions: Number.isInteger(topN) && (topN as number) >= 1 ? (topN as number) : undefined,
    startDate: test.startDate,
    endDate,
    keepOpenAtEnd: true,
    ...(needsRef ? { regimeFilter: { worksIn: strategy.worksIn, failsIn: strategy.failsIn } } : {}),
  });

  const benchByDate = new Map(benchmarkBars.map((b) => [b.date, b.close]));
  const firstBench = benchmarkBars.find((b) => b.date >= test.startDate)?.close ?? null;
  let lastBench: number | null = null;
  const curve = result.equityCurve.map((p) => {
    const close = benchByDate.get(p.date) ?? null;
    if (close !== null) lastBench = close;
    return {
      date: p.date,
      equity: p.equity,
      benchmark:
        firstBench !== null && lastBench !== null
          ? (test.initialCash * lastBench) / firstBench
          : null,
    };
  });
  const last = curve.at(-1);
  const equity = last?.equity ?? test.initialCash;
  const wins = result.trades.filter((t) => t.pnl > 0).length;
  const equities = curve.map((p) => p.equity);
  return {
    test,
    asOf: last?.date ?? null,
    sessions: curve.length,
    equity,
    returnPct: equity / test.initialCash - 1,
    benchmarkReturnPct:
      last?.benchmark !== null && last?.benchmark !== undefined
        ? last.benchmark / test.initialCash - 1
        : null,
    maxDrawdownPct: maxDrawdown(equities),
    tradeCount: result.trades.length,
    winRate: result.trades.length > 0 ? wins / result.trades.length : null,
    openPositions: result.openPositions?.length ?? 0,
    spark: sample([1, ...equities.map((e) => e / test.initialCash)], SPARK_POINTS),
    backtestAnnualPct,
    dataKind: kind,
    error: null,
    curve,
    trades: result.trades
      .map((t) => ({
        ticker: t.ticker,
        side: t.side,
        entryDate: t.entryDate,
        entryPrice: t.entryPrice,
        exitDate: t.exitDate,
        exitPrice: t.exitPrice,
        shares: t.shares,
        pnl: t.pnl,
        exitReason: t.exitReason,
      }))
      .reverse(),
    positions: (result.openPositions ?? []).map((p) => ({
      ticker: p.ticker,
      side: p.side,
      shares: p.shares,
      entryDate: p.entryDate,
      entryPrice: p.entryPrice,
      lastClose: p.lastClose,
      unrealizedPnl: p.unrealizedPnl,
      stopPrice: p.stopPrice,
      targetPrice: p.targetPrice,
    })),
    pendingOrders:
      test.status === 'activa'
        ? (result.pendingOrders ?? []).map((o) => ({ ticker: o.ticker, kind: o.kind }))
        : [],
  };
}

/** Quita lo pesado del detalle para el tablero. */
export function forwardSummaryOf(d: ForwardDetail): ForwardSummary {
  const { curve: _c, trades: _t, positions: _p, pendingOrders: _o, ...summary } = d;
  return summary;
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export interface ForwardServiceDeps {
  repo: ForwardRepository;
  strategies: StrategiesRepository;
  runs: BacktestRepository;
  resolveSource: () => Promise<StressDataSource>;
  impls?: readonly ClassicStrategyDefinition[];
  now?: () => number;
}

export interface ForwardService {
  list(): Promise<ForwardSummary[]>;
  get(id: number): Promise<ForwardDetail | null>;
  start(request: ForwardStartRequest): ForwardTest;
  stop(id: number): ForwardTest;
  remove(id: number): void;
  /** Olvida los cálculos en caché (llegaron velas nuevas). */
  invalidate(): void;
}

export function createForwardService(deps: ForwardServiceDeps): ForwardService {
  const now = deps.now ?? (() => Date.now());
  const impls = deps.impls ?? CLASSIC_STRATEGIES;
  const cache = new Map<number, { at: number; detail: ForwardDetail }>();

  const toTest = (row: ForwardRow, strategy: Strategy | null): ForwardTest => ({
    id: row.id,
    strategyId: row.strategy_id,
    strategyName: strategy?.name ?? `Estrategia ${row.strategy_id}`,
    version: row.version,
    startDate: row.start_date,
    initialCash: row.initial_cash,
    benchmark: row.benchmark,
    markets: strategy ? executableMarkets(strategy.markets) : [],
    status: row.status,
    stoppedAt: row.stopped_at,
    createdAt: row.created_at,
  });

  const createImpl = (strategy: Strategy): (() => EngineStrategy) => {
    const key = deps.runs.implementationKey(strategy.id);
    if (key !== null) {
      const impl = impls.find((entry) => entry.key === key);
      if (!impl) throw new ForwardError('reglas-invalidas', 'sin implementación ejecutable');
      return impl.create;
    }
    const parsed = parseStrategyRules(strategy.rules, strategy.parameters);
    if (!parsed.ok) throw new ForwardError('reglas-invalidas', parsed.errors[0]!.message);
    return () => createCustomStrategy(parsed.program, strategy.parameters);
  };

  const compute = async (row: ForwardRow): Promise<ForwardDetail> => {
    const strategy = deps.strategies.get(row.strategy_id, row.version);
    const test = toTest(row, strategy);
    if (!strategy) return emptyForwardDetail(test, 'La estrategia ya no existe.', 'simulated');
    const backtestAnnualPct =
      deps.runs.latestRun(row.strategy_id, row.version)?.metrics.annualizedReturn ?? null;
    let create: () => EngineStrategy;
    try {
      create = createImpl(strategy);
    } catch (error) {
      return {
        ...emptyForwardDetail(test, (error as Error).message, 'simulated'),
        backtestAnnualPct,
      };
    }
    const source = await deps.resolveSource();
    return computeForward({
      test,
      strategy,
      create,
      getBars: (ticker, desde, hasta) => source.getBars(ticker, desde, hasta),
      today: nyParts(now()).date,
      dataKind: source.kind === 'real' ? 'real' : 'simulated',
      backtestAnnualPct,
    });
  };

  const detail = async (row: ForwardRow): Promise<ForwardDetail> => {
    const hit = cache.get(row.id);
    if (hit && now() - hit.at < CACHE_TTL_MS && hit.detail.test.status === row.status) {
      return hit.detail;
    }
    let computed: ForwardDetail;
    try {
      computed = await compute(row);
    } catch (error) {
      const strategy = deps.strategies.get(row.strategy_id, row.version);
      computed = emptyForwardDetail(
        toTest(row, strategy),
        `No se pudo calcular: ${(error as Error)?.message ?? String(error)}`,
        'simulated',
      );
    }
    if (computed.error === null) cache.set(row.id, { at: now(), detail: computed });
    return computed;
  };

  return {
    list: async () => {
      const out: ForwardSummary[] = [];
      for (const row of deps.repo.list()) out.push(forwardSummaryOf(await detail(row)));
      return out;
    },
    get: async (id) => {
      const row = deps.repo.get(id);
      return row ? detail(row) : null;
    },
    start: (request) => {
      const strategy = deps.strategies.get(request.strategyId);
      if (!strategy) {
        throw new ForwardError('not-found', `no existe la estrategia ${request.strategyId}`);
      }
      createImpl(strategy); // falla pronto si las reglas no compilan
      if (executableMarkets(strategy.markets).length === 0) {
        throw new ForwardError('invalid-input', 'la estrategia no tiene mercados operables');
      }
      const row = deps.repo.insert({
        strategy_id: strategy.id,
        version: strategy.version,
        start_date: forwardStartDate(now()),
        initial_cash: request.initialCash ?? FORWARD_DEFAULT_CASH,
        // Referencia: comprar y mantener el primer activo de la estrategia.
        benchmark: executableMarkets(strategy.markets)[0] ?? 'SPY',
      });
      return toTest(row, strategy);
    },
    stop: (id) => {
      const row = deps.repo.get(id);
      if (!row) throw new ForwardError('not-found', `no existe la prueba ${id}`);
      deps.repo.stop(id, new Date(now()).toISOString());
      cache.delete(id);
      const updated = deps.repo.get(id)!;
      return toTest(updated, deps.strategies.get(updated.strategy_id, updated.version));
    },
    remove: (id) => {
      deps.repo.remove(id);
      cache.delete(id);
    },
    invalidate: () => cache.clear(),
  };
}
