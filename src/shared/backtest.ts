/**
 * Contrato compartido del servicio de backtest — Fase 2.
 *
 * Tipos que cruzan el IPC entre el proceso principal
 * (`src/main/backtest/service.ts`), el preload y el renderer. Todo lo que
 * se serializa a SQLite o viaja por `ipcRenderer` es JSON puro: los
 * valores no finitos (±Infinity de Sharpe o del factor de beneficio) se
 * normalizan a `null` + bandera antes de guardarse.
 *
 * Los guardas de entrada IPC que usan estos tipos están en
 * `src/shared/ipc.ts` junto al resto del contrato.
 */
import type { StrategyCosts } from './strategy';

// ---------------------------------------------------------------------------
// Ejecución y progreso
// ---------------------------------------------------------------------------

/** Etapas del pipeline de un backtest (evento `backtest:progress`). */
export const BACKTEST_STAGES = [
  'descargando',
  'backtest',
  'metricas',
  'walk-forward',
  'sensibilidad',
  'monte-carlo',
  'estres',
  'guardando',
  'completado',
  'error',
] as const;
export type BacktestStage = (typeof BACKTEST_STAGES)[number];

/** Evento `backtest:progress` (main → renderer) durante una ejecución. */
export interface BacktestProgressEvent {
  /** Identificador de la ejecución en curso (varios runs pueden coexistir). */
  ticket: string;
  strategyId: number;
  stage: BacktestStage;
  /** Progreso aproximado 0–100 dentro de la ejecución. */
  percent: number;
  /** Elemento actual (ticker, ventana «3/12», celda…); null si no aplica. */
  detail: string | null;
  /** Ms transcurridos desde el inicio de la ejecución. */
  elapsedMs: number;
}

/** Método de la simulación Monte Carlo (ver backtest/validation.ts). */
export const MONTE_CARLO_METHODS = ['permutation', 'bootstrap'] as const;
export type MonteCarloMethod = (typeof MONTE_CARLO_METHODS)[number];

/** Métrica objetivo de walk-forward y del mapa de sensibilidad. */
export const OBJECTIVE_METRIC_NAMES = [
  'sharpe',
  'totalReturn',
  'profitFactor',
  'expectancy',
] as const;
export type ObjectiveMetricName = (typeof OBJECTIVE_METRIC_NAMES)[number];

/** Opciones del bloque walk-forward de una ejecución. */
export interface WalkForwardOptions {
  /** Sesiones de entrenamiento por ventana (def. 126). */
  trainSize?: number;
  /** Sesiones fuera de muestra por ventana (def. 63). */
  testSize?: number;
  /** Paso entre ventanas en sesiones (def. testSize). */
  step?: number;
  /** Métrica a maximizar en muestra (def. 'sharpe'). */
  objective?: ObjectiveMetricName;
}

/** Opciones de la simulación Monte Carlo de una ejecución. */
export interface MonteCarloOptions {
  /** Semilla del PRNG; la misma reproduce la distribución exacta (def. 1). */
  seed?: number;
  /** Número de simulaciones (def. 1 000, máx. 100 000). */
  simulations?: number;
  /** 'permutation' conserva la suma de PnL; 'bootstrap' remuestrea. */
  method?: MonteCarloMethod;
}

/** Proporciones de la división entrenamiento/validación/prueba (suman 1). */
export interface SplitRatiosInput {
  train?: number;
  validation?: number;
  test?: number;
}

/** Ejes del mapa de sensibilidad: dos nombres de parámetro con rango en la ficha. */
export interface SensitivityAxes {
  xParam?: string;
  yParam?: string;
}

/**
 * Petición de `backtest:run`. El periodo por defecto sale de la ficha
 * (entrenamiento + fuera de muestra); el universo, de sus mercados que sean
 * tickers válidos. El tramo de prueba (último 20 % por defecto) nunca se
 * ejecuta aquí: queda bloqueado para `backtest:run-final-test`.
 */
export interface BacktestRunRequest {
  strategyId: number;
  /** Versión concreta; por defecto la vigente. */
  version?: number;
  /** Ambos inclusive, 'YYYY-MM-DD'. */
  desde?: string;
  hasta?: string;
  /** Tickers del universo; por defecto los mercados de la ficha válidos. */
  universe?: string[];
  /** Capital inicial (def. 10 000). */
  initialCash?: number;
  /** Fracción del capital arriesgada por operación, 0,005–0,01 (def. 0,01). */
  riskPerTrade?: number;
  /** Máximo de posiciones simultáneas (def. topN de la ficha o 5). */
  maxPositions?: number;
  /** Costes del run; por defecto los asumidos en la ficha (comisión en %). */
  costs?: Partial<StrategyCosts>;
  /** Parámetros del run: se fusionan sobre los de la versión. */
  params?: Record<string, number>;
  /** Proporciones de la división (def. 0,6/0,2/0,2). */
  split?: SplitRatiosInput;
  /** Walk-forward: `false` lo omite; objeto lo configura. */
  walkForward?: false | WalkForwardOptions;
  /** Mapa de sensibilidad: `false` lo omite; objeto elige los dos ejes. */
  sensitivity?: false | SensitivityAxes;
  /** Monte Carlo: `false` lo omite; objeto lo configura. */
  monteCarlo?: false | MonteCarloOptions;
}

/** Filtros de `backtest:list`; sin `strategyId` lista todas las ejecuciones. */
export interface BacktestListQuery {
  strategyId?: number;
  version?: number;
  /** Máximo de filas (def. 100, tope 500). */
  limit?: number;
}

/** Petición de `backtest:run-final-test`: ejecuta el tramo bloqueado una vez. */
export interface BacktestFinalTestRequest {
  strategyId: number;
  version?: number;
}

/** Consulta o ejecución de las pruebas de estrés de una estrategia. */
export interface StressRequest {
  strategyId: number;
  version?: number;
}

// ---------------------------------------------------------------------------
// Informe persistido
// ---------------------------------------------------------------------------

/** Tipo de ejecución guardada. */
export const BACKTEST_RUN_KINDS = ['completo', 'prueba-final'] as const;
export type BacktestRunKind = (typeof BACKTEST_RUN_KINDS)[number];

/** Etiqueta de la fuente de datos que muestra el informe. */
export type BacktestDataSource = 'simulated' | 'real';

/** Episodio de drawdown máximo (ver backtest/metrics.ts). */
export interface DrawdownDto {
  /** Caída en tanto por uno, positiva. */
  pct: number;
  peakDate: string;
  troughDate: string;
  recoveryDate: string | null;
  durationDays: number;
}

/**
 * Métricas del informe. JSON-safe: `sharpe`/`profitFactor` no finitos se
 * guardan como null y se declaran en `sharpeInfinite`/`profitFactorInfinite`.
 */
export interface BacktestMetricsDto {
  /** Rentabilidad total en tanto por uno; null sin curva. */
  totalReturn: number | null;
  annualizedReturn: number | null;
  maxDrawdown: DrawdownDto | null;
  /** Sharpe anualizado; null si no está definido o es infinito. */
  sharpe: number | null;
  /** 'positive'/'negative' si el Sharpe era ±Infinity (varianza cero). */
  sharpeInfinite: 'positive' | 'negative' | null;
  /** Factor de beneficio; null si no está definido o es infinito. */
  profitFactor: number | null;
  /** true si el factor de beneficio era ∞ (ganancias sin pérdidas). */
  profitFactorInfinite: boolean;
  winRate: number | null;
  expectancy: number | null;
  maxLosingStreak: number;
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  grossProfit: number;
  grossLoss: number;
}

/** Punto diario de la curva de capital. */
export interface EquityPointDto {
  date: string;
  cash: number;
  equity: number;
  positions: number;
}

/** Una operación cerrada del backtest. */
export interface TradeDto {
  ticker: string;
  signalDate: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  shares: number;
  commission: number;
  slippage: number;
  grossPnl: number;
  pnl: number;
  exitReason: 'signal' | 'stop' | 'target' | 'delisted' | 'end-of-data';
}

/** Periodo de sesiones, ambas fechas inclusive. */
export interface SessionRangeDto {
  startDate: string;
  endDate: string;
}

/** División entrenamiento/validación/prueba usada por la ejecución. */
export interface DataSplitDto {
  train: SessionRangeDto;
  validation: SessionRangeDto;
  /** Tramo bloqueado: solo `backtest:run-final-test` lo ejecuta, una vez. */
  test: SessionRangeDto;
  counts: { train: number; validation: number; test: number };
  sessionCount: number;
}

/** Una ventana walk-forward evaluada. */
export interface WalkForwardWindowDto {
  index: number;
  train: SessionRangeDto;
  test: SessionRangeDto;
  /** Parámetros ganadores en la ventana de entrenamiento. */
  params: Record<string, number>;
  inSampleMetric: number | null;
  inSampleMetrics: BacktestMetricsDto;
  outOfSampleMetric: number | null;
  outOfSampleMetrics: BacktestMetricsDto;
  candidates: number;
}

export interface WalkForwardDto {
  objective: ObjectiveMetricName;
  trainSize: number;
  testSize: number;
  step: number;
  windows: WalkForwardWindowDto[];
  meanInSampleMetric: number | null;
  meanOutOfSampleMetric: number | null;
  /** Total de operaciones fuera de muestra encadenadas por las ventanas. */
  outOfSampleTrades: number;
}

/** Mapa 2D de sensibilidad: `cells[y][x]` con la métrica elegida. */
export interface SensitivityDto {
  metric: ObjectiveMetricName;
  xParam: string;
  xValues: number[];
  yParam: string;
  yValues: number[];
  cells: (number | null)[][];
  baseCell: { x: number; y: number };
  baseValue: number | null;
}

export interface MonteCarloPercentilesDto {
  p5: number;
  p50: number;
  p95: number;
}

export interface MonteCarloSampleDto {
  totalReturn: number;
  maxDrawdown: number;
}

export interface MonteCarloDto {
  method: MonteCarloMethod;
  seed: number;
  simulations: number;
  tradeCount: number;
  initialCash: number;
  returnPercentiles: MonteCarloPercentilesDto;
  drawdownPercentiles: MonteCarloPercentilesDto;
  /** Una entrada por simulación, para el histograma del informe. */
  distribution: MonteCarloSampleDto[];
}

/**
 * Aviso del informe. `severity` sigue los tokens del diseño:
 * 'info' (datos simulados/reales), 'method' (avisos metodológicos como
 * «sesgo de supervivencia residual» o «rendimientos pasados») y 'critical'
 * (sobreajuste y errores que invalidan la lectura del resultado).
 */
export interface BacktestNotice {
  rule: string;
  severity: 'info' | 'method' | 'critical';
  message: string;
}

/** Estado de la prueba final bloqueada de una versión. */
export interface FinalTestState {
  /** 'disponible' si aún puede ejecutarse; 'ejecutada' si ya se consumió. */
  status: 'disponible' | 'ejecutada';
  /** Id del run 'prueba-final' guardado; null si no se ha ejecutado. */
  runId: number | null;
  executedAt: string | null;
}

/** Referencia comprar-y-mantener del informe (SPY por defecto). */
export interface BenchmarkDto {
  ticker: string;
  /** Rentabilidad primer cierre → último cierre del periodo ejecutado. */
  totalReturn: number | null;
  /** Curva de capital del benchmark, misma escala que la estrategia. */
  curve: EquityPointDto[];
}

/** Configuración efectivamente usada por una ejecución (valores resueltos). */
export interface BacktestRunConfig {
  /** Periodo pedido (ambos inclusive, 'YYYY-MM-DD'). */
  desde: string;
  hasta: string;
  /** Tramo ejecutado de verdad: [desde, division.validation.endDate]. */
  ejecutadoHasta: string | null;
  /** Tickers del universo ejecutado. */
  markets: string[];
  initialCash: number;
  riskPerTrade: number;
  maxPositions: number;
  parameters: Record<string, number>;
  /** Sesiones de calentamiento descargadas antes de `desde`. */
  warmupSessions: number;
  split: { train: number; validation: number; test: number };
  walkForward: WalkForwardOptions | null;
  sensitivity: { xParam: string; yParam: string } | null;
  monteCarlo: { seed: number; simulations: number; method: MonteCarloMethod } | null;
}

/** Fila de `backtest:list`: resumen de una ejecución guardada. */
export interface BacktestRunSummary {
  id: number;
  strategyId: number;
  version: number;
  kind: BacktestRunKind;
  dataSource: BacktestDataSource;
  providerId: string;
  totalReturn: number | null;
  maxDrawdownPct: number | null;
  sharpe: number | null;
  tradeCount: number;
  durationMs: number;
  createdAt: string;
}

/** Informe completo de una ejecución guardada (`backtest:get`). */
export interface BacktestReport extends BacktestRunSummary {
  config: BacktestRunConfig;
  /** Costes aplicados al run, en el formato de la ficha (comisión en %). */
  costs: StrategyCosts;
  /** División usada; null en runs de tipo 'prueba-final'. */
  split: DataSplitDto | null;
  metrics: BacktestMetricsDto;
  equityCurve: EquityPointDto[];
  trades: TradeDto[];
  walkForward: WalkForwardDto | null;
  sensitivity: SensitivityDto | null;
  monteCarlo: MonteCarloDto | null;
  warnings: BacktestNotice[];
  benchmark: BenchmarkDto | null;
  finalTest: FinalTestState;
}

/** Resultado de una prueba de estrés en una ventana de crisis. */
export interface StressResultDto {
  /** '2008' | '2020' | '2022'. */
  crisisId: string;
  crisisName: string;
  desde: string;
  hasta: string;
  /** Sesiones simuladas dentro de la ventana; 0 si la fuente no tenía datos. */
  sessions: number;
  totalReturn: number | null;
  maxDrawdown: number | null;
  trades: number;
  benchmarkTicker: string;
  /** Comprar y mantener el benchmark en la ventana (tanto por uno). */
  benchmarkReturn: number | null;
  dataSource: BacktestDataSource;
  providerId: string;
  /** Minicurva de capital de la ventana (sin calentamiento). */
  equityCurve: EquityPointDto[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Constantes del dominio
// ---------------------------------------------------------------------------

/** Límites de entrada del contrato. */
export const BACKTEST_MAX_UNIVERSE = 64;
export const BACKTEST_MAX_LIMIT = 500;
export const BACKTEST_MIN_INITIAL_CASH = 1;
export const BACKTEST_MAX_INITIAL_CASH = 100_000_000;
/** Riesgo por operación admitido (fracción del capital). */
export const BACKTEST_MIN_RISK_PER_TRADE = 0.005;
export const BACKTEST_MAX_RISK_PER_TRADE = 0.01;
export const BACKTEST_MAX_POSITIONS = 25;
export const MONTE_CARLO_MAX_SIMULATIONS = 100_000;
