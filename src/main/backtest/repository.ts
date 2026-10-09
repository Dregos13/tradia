/**
 * Repositorio de backtests y pruebas de estrés — Fase 2.
 *
 * Único punto de escritura/lectura de `backtest_runs`, `stress_results` y
 * `strategy_implementations` (migración 006). Las columnas de la base usan
 * el español de la migración; la superficie expone los DTO en inglés de
 * `shared/backtest.ts`.
 *
 * Reglas de negocio:
 * - Un run 'completo' guarda config, costes, división, métricas, curva,
 *   operaciones y los bloques de robustez que el run ejecutó.
 * - La prueba final es un run 'prueba-final': una sola por versión. El
 *   servicio lo comprueba antes de lanzarla y aquí se reafirma en la misma
 *   transacción (además del índice único parcial de la migración).
 * - Las pruebas de estrés van por (estrategia, versión, crisis): repetirla
 *   sobrescribe el resultado anterior (UPSERT).
 */
import type Database from 'better-sqlite3';

import { BACKTEST_MAX_LIMIT } from '../../shared/backtest';
import type {
  BacktestDataSource,
  BacktestMetricsDto,
  BacktestNotice,
  BacktestReport,
  BacktestRunConfig,
  BacktestRunKind,
  BacktestRunSummary,
  BenchmarkDto,
  DataSplitDto,
  EquityPointDto,
  FinalTestState,
  MonteCarloDto,
  SensitivityDto,
  StressResultDto,
  TradeDto,
  WalkForwardDto,
} from '../../shared/backtest';
import type { StrategyCosts } from '../../shared/strategy';
import { FinalTestLockedError } from './validation';

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export const BACKTEST_ERROR_CODES = [
  'not-found',
  'invalid-input',
  'sin-implementacion',
  'sin-datos',
] as const;
export type BacktestErrorCode = (typeof BACKTEST_ERROR_CODES)[number];

export class BacktestError extends Error {
  readonly code: BacktestErrorCode;

  constructor(code: BacktestErrorCode, message: string) {
    super(message);
    this.name = 'BacktestError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Filas crudas de SQLite
// ---------------------------------------------------------------------------

interface RunRow {
  id: number;
  strategy_id: number;
  version: number;
  kind: BacktestRunKind;
  config: string;
  costes: string;
  division: string | null;
  metricas: string;
  curva: string;
  operaciones: string;
  walk_forward: string | null;
  sensibilidad: string | null;
  monte_carlo: string | null;
  benchmark: string | null;
  avisos: string;
  fuente: BacktestDataSource;
  proveedor: string;
  duracion_ms: number;
  creado_en: string;
}

interface StressRow {
  id: number;
  strategy_id: number;
  version: number;
  crisis: string;
  crisis_nombre: string;
  desde: string;
  hasta: string;
  sesiones: number;
  rentabilidad: number | null;
  drawdown: number | null;
  operaciones: number;
  benchmark: string;
  benchmark_rentabilidad: number | null;
  fuente: BacktestDataSource;
  proveedor: string;
  curva: string;
  creado_en: string;
}

const RUN_COLUMNS =
  'id, strategy_id, version, kind, config, costes, division, metricas, curva, ' +
  'operaciones, walk_forward, sensibilidad, monte_carlo, benchmark, avisos, ' +
  'fuente, proveedor, duracion_ms, creado_en';

// ---------------------------------------------------------------------------
// JSON defensivo (mismo criterio que strategies/repository.ts)
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string | null, fallback: T, what: string, ref: string): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn(`[backtest] ${what} ilegible en ${ref}; se devuelve el valor por defecto`);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Registro de un run
// ---------------------------------------------------------------------------

/** Datos de una ejecución a persistir (los DTO ya son JSON-safe). */
export interface NewBacktestRun {
  strategyId: number;
  version: number;
  kind: BacktestRunKind;
  config: BacktestRunConfig;
  costs: StrategyCosts;
  split: DataSplitDto | null;
  metrics: BacktestMetricsDto;
  equityCurve: EquityPointDto[];
  trades: TradeDto[];
  walkForward: WalkForwardDto | null;
  sensitivity: SensitivityDto | null;
  monteCarlo: MonteCarloDto | null;
  benchmark: BenchmarkDto | null;
  warnings: BacktestNotice[];
  dataSource: BacktestDataSource;
  providerId: string;
  durationMs: number;
}

export interface BacktestRepository {
  /** Inserta el run y devuelve su id. 'prueba-final' duplicada lanza FinalTestLockedError. */
  saveRun(run: NewBacktestRun): number;
  /** Informe completo de un run; null si no existe. */
  getRun(id: number): BacktestReport | null;
  /** Ejecuciones guardadas, más recientes primero. */
  listRuns(query?: { strategyId?: number; version?: number; limit?: number }): BacktestRunSummary[];
  /** Estado de la prueba final de una versión (disponible/ejecutada + run). */
  finalTestState(strategyId: number, version: number): FinalTestState;
  /** Último run de un tipo para una versión (p. ej. el 'completo' de referencia). */
  latestRun(strategyId: number, version: number, kind?: BacktestRunKind): BacktestReport | null;

  /** UPSERT de los resultados de una ventana de crisis para una versión. */
  saveStressResults(
    strategyId: number,
    version: number,
    results: Omit<StressResultDto, 'createdAt'>[],
  ): void;
  /** Crisis guardadas de la versión (o de la vigente), en orden 2008→2020→2022. */
  listStress(strategyId: number, version: number): StressResultDto[];

  /** Clave de implementación ejecutable de la estrategia, o null. */
  implementationKey(strategyId: number): string | null;
  /** Estrategia enlazada a una clave de implementación, o null. */
  strategyIdForImpl(implKey: string): number | null;
  /** Registra la implementación ejecutable de una estrategia (semilla). */
  setImplementation(strategyId: number, implKey: string): void;
}

export function createBacktestRepository(db: Database.Database): BacktestRepository {
  const selectRun = db.prepare(`SELECT ${RUN_COLUMNS} FROM backtest_runs WHERE id = ?`);
  const selectFinalTest = db.prepare(
    `SELECT id, creado_en FROM backtest_runs
     WHERE strategy_id = ? AND version = ? AND kind = 'prueba-final'`,
  );
  const insertRun = db.prepare(
    `INSERT INTO backtest_runs (
       strategy_id, version, kind, config, costes, division, metricas, curva,
       operaciones, walk_forward, sensibilidad, monte_carlo, benchmark, avisos,
       fuente, proveedor, duracion_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertStress = db.prepare(
    `INSERT INTO stress_results (
       strategy_id, version, crisis, crisis_nombre, desde, hasta, sesiones,
       rentabilidad, drawdown, operaciones, benchmark, benchmark_rentabilidad,
       fuente, proveedor, curva
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (strategy_id, version, crisis) DO UPDATE SET
       crisis_nombre = excluded.crisis_nombre,
       desde = excluded.desde,
       hasta = excluded.hasta,
       sesiones = excluded.sesiones,
       rentabilidad = excluded.rentabilidad,
       drawdown = excluded.drawdown,
       operaciones = excluded.operaciones,
       benchmark = excluded.benchmark,
       benchmark_rentabilidad = excluded.benchmark_rentabilidad,
       fuente = excluded.fuente,
       proveedor = excluded.proveedor,
       curva = excluded.curva,
       creado_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );

  const toSummary = (row: RunRow): BacktestRunSummary => {
    const ref = `run ${row.id}`;
    const metrics = parseJson<BacktestMetricsDto | null>(
      row.metricas,
      null,
      'metricas',
      ref,
    );
    return {
      id: row.id,
      strategyId: row.strategy_id,
      version: row.version,
      kind: row.kind,
      dataSource: row.fuente,
      providerId: row.proveedor,
      totalReturn: metrics?.totalReturn ?? null,
      maxDrawdownPct: metrics?.maxDrawdown?.pct ?? null,
      sharpe: metrics?.sharpe ?? null,
      tradeCount: metrics?.tradeCount ?? 0,
      durationMs: row.duracion_ms,
      createdAt: row.creado_en,
    };
  };

  const toReport = (row: RunRow): BacktestReport => ({
    ...toSummary(row),
    config: parseJson<BacktestRunConfig>(
      row.config,
      {} as BacktestRunConfig,
      'config',
      `run ${row.id}`,
    ),
    costs: parseJson<StrategyCosts>(
      row.costes,
      { commissionPct: 0, commissionMin: 0, slippageBps: 0, spreadBps: 0 },
      'costes',
      `run ${row.id}`,
    ),
    split: parseJson<DataSplitDto | null>(row.division, null, 'division', `run ${row.id}`),
    metrics: parseJson<BacktestMetricsDto>(
      row.metricas,
      {} as BacktestMetricsDto,
      'metricas',
      `run ${row.id}`,
    ),
    equityCurve: parseJson<EquityPointDto[]>(row.curva, [], 'curva', `run ${row.id}`),
    trades: parseJson<TradeDto[]>(row.operaciones, [], 'operaciones', `run ${row.id}`),
    walkForward: parseJson<WalkForwardDto | null>(
      row.walk_forward,
      null,
      'walk_forward',
      `run ${row.id}`,
    ),
    sensitivity: parseJson<SensitivityDto | null>(
      row.sensibilidad,
      null,
      'sensibilidad',
      `run ${row.id}`,
    ),
    monteCarlo: parseJson<MonteCarloDto | null>(
      row.monte_carlo,
      null,
      'monte_carlo',
      `run ${row.id}`,
    ),
    benchmark: parseJson<BenchmarkDto | null>(row.benchmark, null, 'benchmark', `run ${row.id}`),
    warnings: parseJson<BacktestNotice[]>(row.avisos, [], 'avisos', `run ${row.id}`),
    finalTest: repo.finalTestState(row.strategy_id, row.version),
  });

  const repo: BacktestRepository = {
    saveRun: (run) => {
      return db.transaction(() => {
        if (
          run.kind === 'prueba-final' &&
          selectFinalTest.get(run.strategyId, run.version) !== undefined
        ) {
          throw new FinalTestLockedError(
            `la prueba final ya se ejecutó para la estrategia ${run.strategyId} v${run.version}`,
          );
        }
        const result = insertRun.run(
          run.strategyId,
          run.version,
          run.kind,
          JSON.stringify(run.config),
          JSON.stringify(run.costs),
          run.split === null ? null : JSON.stringify(run.split),
          JSON.stringify(run.metrics),
          JSON.stringify(run.equityCurve),
          JSON.stringify(run.trades),
          run.walkForward === null ? null : JSON.stringify(run.walkForward),
          run.sensitivity === null ? null : JSON.stringify(run.sensitivity),
          run.monteCarlo === null ? null : JSON.stringify(run.monteCarlo),
          run.benchmark === null ? null : JSON.stringify(run.benchmark),
          JSON.stringify(run.warnings),
          run.dataSource,
          run.providerId,
          Math.round(run.durationMs),
        );
        return Number(result.lastInsertRowid);
      })();
    },

    getRun: (id) => {
      const row = selectRun.get(id) as RunRow | undefined;
      return row === undefined ? null : toReport(row);
    },

    listRuns: (query = {}) => {
      const clauses: string[] = [];
      const params: number[] = [];
      if (query.strategyId !== undefined) {
        clauses.push('strategy_id = ?');
        params.push(query.strategyId);
      }
      if (query.version !== undefined) {
        clauses.push('version = ?');
        params.push(query.version);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.min(query.limit ?? 100, BACKTEST_MAX_LIMIT);
      const rows = db
        .prepare(`SELECT ${RUN_COLUMNS} FROM backtest_runs ${where} ORDER BY id DESC LIMIT ?`)
        .all(...params, limit) as RunRow[];
      return rows.map(toSummary);
    },

    finalTestState: (strategyId, version) => {
      const row = selectFinalTest.get(strategyId, version) as
        | { id: number; creado_en: string }
        | undefined;
      return row === undefined
        ? { status: 'disponible', runId: null, executedAt: null }
        : { status: 'ejecutada', runId: row.id, executedAt: row.creado_en };
    },

    latestRun: (strategyId, version, kind = 'completo') => {
      const row = db
        .prepare(
          `SELECT ${RUN_COLUMNS} FROM backtest_runs
           WHERE strategy_id = ? AND version = ? AND kind = ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get(strategyId, version, kind) as RunRow | undefined;
      return row === undefined ? null : toReport(row);
    },

    saveStressResults: (strategyId, version, results) => {
      db.transaction(() => {
        for (const r of results) {
          upsertStress.run(
            strategyId,
            version,
            r.crisisId,
            r.crisisName,
            r.desde,
            r.hasta,
            r.sessions,
            r.totalReturn,
            r.maxDrawdown,
            r.trades,
            r.benchmarkTicker,
            r.benchmarkReturn,
            r.dataSource,
            r.providerId,
            JSON.stringify(r.equityCurve),
          );
        }
      })();
    },

    listStress: (strategyId, version) => {
      const rows = db
        .prepare(
          `SELECT id, strategy_id, version, crisis, crisis_nombre, desde, hasta,
                  sesiones, rentabilidad, drawdown, operaciones, benchmark,
                  benchmark_rentabilidad, fuente, proveedor, curva, creado_en
           FROM stress_results
           WHERE strategy_id = ? AND version = ?
           ORDER BY crisis`,
        )
        .all(strategyId, version) as StressRow[];
      return rows.map((row) => ({
        crisisId: row.crisis,
        crisisName: row.crisis_nombre,
        desde: row.desde,
        hasta: row.hasta,
        sessions: row.sesiones,
        totalReturn: row.rentabilidad,
        maxDrawdown: row.drawdown,
        trades: row.operaciones,
        benchmarkTicker: row.benchmark,
        benchmarkReturn: row.benchmark_rentabilidad,
        dataSource: row.fuente,
        providerId: row.proveedor,
        equityCurve: parseJson<EquityPointDto[]>(
          row.curva,
          [],
          'curva de estrés',
          `estrés ${row.id}`,
        ),
        createdAt: row.creado_en,
      }));
    },

    implementationKey: (strategyId) => {
      const row = db
        .prepare('SELECT impl_key FROM strategy_implementations WHERE strategy_id = ?')
        .get(strategyId) as { impl_key: string } | undefined;
      return row?.impl_key ?? null;
    },

    strategyIdForImpl: (implKey) => {
      const row = db
        .prepare('SELECT strategy_id FROM strategy_implementations WHERE impl_key = ?')
        .get(implKey) as { strategy_id: number } | undefined;
      return row?.strategy_id ?? null;
    },

    setImplementation: (strategyId, implKey) => {
      db.prepare(
        `INSERT INTO strategy_implementations (strategy_id, impl_key) VALUES (?, ?)
         ON CONFLICT (strategy_id) DO UPDATE SET impl_key = excluded.impl_key`,
      ).run(strategyId, implKey);
    },
  };

  return repo;
}
