/**
 * Validación de estrategias: división de datos, walk-forward, mapa de
 * sensibilidad, Monte Carlo y avisos de sobreajuste — Fase 2.
 *
 * Módulo puro (sin Electron, sin Node, sin estado global) que combina el
 * motor (`engine.ts`) y las métricas (`metrics.ts`). Todo lo que el informe
 * necesita para demostrar que el resultado no es fruto del azar:
 *
 * - `splitTimeline`: separación 60/20/20 en entrenamiento, validación y
 *   prueba final. La prueba final es un segmento bloqueado: solo puede
 *   ejecutarse una vez por versión de estrategia. El bloqueo lo persiste
 *   el servicio; aquí se expone con la bandera `alreadyExecuted` de
 *   `runFinalTest`, que lanza `FinalTestLockedError` si ya se consumió.
 * - `buildWalkForwardWindows` + `runWalkForward`: ventanas rodantes que
 *   optimizan sobre la ventana de entrenamiento (rejilla de parámetros) y
 *   evalúan en la siguiente ventana fuera de muestra.
 * - `runSensitivityMap`: rejilla 2D de parámetros con la métrica elegida
 *   en cada celda, y la celda base (la más cercana a los parámetros de la
 *   versión) que usa la regla de vecinos.
 * - `runMonteCarlo`: permutación o remuestreo del orden de las operaciones
 *   con semilla (N = 1 000 por defecto). Devuelve los percentiles 5/50/95
 *   de rentabilidad y drawdown y la distribución completa por simulación
 *   para el histograma del informe.
 * - `evaluateOverfitting`: las tres reglas de aviso de sobreajuste de los
 *   supuestos del plan, cada una con su texto explicativo.
 *
 * Las estrategias se piden como factoría `() => Strategy`: la optimización
 * ejecuta muchos backtests y cada uno necesita una instancia limpia (el
 * motor llama a `init`, pero la estrategia puede guardar estado propio).
 *
 * Los supuestos del plan (ver el plan de la fase):
 * - División de datos: 60 % entrenamiento, 20 % validación y 20 % prueba
 *   final bloqueada; la prueba solo se ejecuta una vez por versión.
 * - Aviso de sobreajuste si se cumple cualquiera de:
 *   1. el Sharpe fuera de muestra es menor que el 50 % del de entrenamiento;
 *   2. más de la mitad de los vecinos del mapa de sensibilidad pierden más
 *      del 50 % del resultado del punto elegido;
 *   3. el percentil 5 de Monte Carlo tiene rentabilidad negativa con un
 *      drawdown por encima del 10 %.
 */
import { runBacktest } from './engine';
import { computeMetrics, type BacktestMetrics, type MetricTrade } from './metrics';
import type { BacktestInput, BacktestResult, EngineBar, Strategy, StrategyParams } from './types';
import type { SessionDate } from '../market/providers/types';
import type { StrategyParameterRange } from '../../shared/strategy';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Tope de combinaciones de una rejilla de parámetros (walk-forward y sensibilidad). */
export const MAX_GRID_COMBINATIONS = 1024;

/** Número de simulaciones Monte Carlo por defecto (plan: 1 000). */
export const DEFAULT_MONTE_CARLO_SIMULATIONS = 1000;
/** Tope de simulaciones Monte Carlo. */
export const MAX_MONTE_CARLO_SIMULATIONS = 100_000;
/** Semilla por defecto de Monte Carlo. */
export const DEFAULT_MONTE_CARLO_SEED = 1;

/** Umbral de drawdown (10 %) de la regla de cola de Monte Carlo. */
export const MONTE_CARLO_TAIL_DRAWDOWN = 0.1;
/** Umbral de decaimiento del Sharpe fuera de muestra (50 % del de entrenamiento). */
export const SHARPE_DECAY_RATIO = 0.5;
/** Caída de la métrica de un vecino que cuenta como colapso (>50 % del resultado). */
export const SENSITIVITY_COLLAPSE_RATIO = 0.5;

// ---------------------------------------------------------------------------
// Fechas y división entrenamiento / validación / prueba
// ---------------------------------------------------------------------------

/** Un periodo de sesiones, ambas fechas inclusive ('YYYY-MM-DD'). */
export interface SessionRange {
  startDate: SessionDate;
  endDate: SessionDate;
}

/** Proporciones de la división temporal; deben sumar 1. */
export interface SplitRatios {
  train: number;
  validation: number;
  test: number;
}

/** División por defecto del plan: 60 % / 20 % / 20 %. */
export const DEFAULT_SPLIT_RATIOS: SplitRatios = { train: 0.6, validation: 0.2, test: 0.2 };

/**
 * Resultado de la división: tres periodos disjuntos y ordenados que cubren
 * toda la línea temporal. La prueba queda al final y bloqueada.
 */
export interface DataSplit {
  train: SessionRange;
  validation: SessionRange;
  /** Prueba final bloqueada: ejecutable una sola vez por versión. */
  test: SessionRange;
  /** Sesiones por segmento (suman `sessionCount`). */
  counts: { train: number; validation: number; test: number };
  sessionCount: number;
}

/** Unión ordenada de las fechas de vela de todos los activos (como la línea temporal del motor). */
export function unionDates(bars: Record<string, readonly EngineBar[]>): SessionDate[] {
  const dates = new Set<SessionDate>();
  for (const series of Object.values(bars)) {
    for (const bar of series) dates.add(bar.date);
  }
  return [...dates].sort();
}

function normalizeDates(dates: readonly SessionDate[]): SessionDate[] {
  const unique = new Set<SessionDate>();
  for (const date of dates) {
    if (typeof date !== 'string' || !ISO_DATE.test(date)) {
      throw new RangeError(`validación: fecha inválida (${JSON.stringify(date)})`);
    }
    unique.add(date);
  }
  return [...unique].sort();
}

function normalizeRatios(ratios: Partial<SplitRatios> | undefined): SplitRatios {
  const merged = { ...DEFAULT_SPLIT_RATIOS, ...ratios };
  for (const [field, value] of Object.entries(merged)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
      throw new RangeError(`validación: la proporción '${field}' debe estar en (0, 1) (${value})`);
    }
  }
  if (Math.abs(merged.train + merged.validation + merged.test - 1) > 1e-9) {
    throw new RangeError(
      `validación: las proporciones deben sumar 1 (train ${merged.train} + validation ${merged.validation} + test ${merged.test})`,
    );
  }
  return merged;
}

/**
 * Divide la línea temporal en entrenamiento, validación y prueba según las
 * proporciones (def. 60/20/20). Cada segmento conserva al menos una sesión;
 * hacen falta al menos 3 fechas distintas.
 *
 * Los segmentos son disjuntos y consecutivos: `train.endDate <
 * validation.startDate < test.startDate`. Las velas anteriores a cada
 * segmento sirven de calentamiento al ejecutar el motor sobre él (datos del
 * pasado, nunca del futuro).
 */
export function splitTimeline(
  dates: readonly SessionDate[],
  ratios?: Partial<SplitRatios>,
): DataSplit {
  const ordered = normalizeDates(dates);
  const r = normalizeRatios(ratios);
  const n = ordered.length;
  if (n < 3) {
    throw new RangeError(`validación: hacen falta al menos 3 sesiones para dividir (hay ${n})`);
  }

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  const trainCount = clamp(Math.floor(n * r.train), 1, n - 2);
  const validationCount = clamp(Math.floor(n * r.validation), 1, n - 1 - trainCount);
  const testCount = n - trainCount - validationCount;

  const range = (from: number, count: number): SessionRange => ({
    startDate: ordered[from]!,
    endDate: ordered[from + count - 1]!,
  });

  return {
    train: range(0, trainCount),
    validation: range(trainCount, validationCount),
    test: range(trainCount + validationCount, testCount),
    counts: { train: trainCount, validation: validationCount, test: testCount },
    sessionCount: n,
  };
}

// ---------------------------------------------------------------------------
// Ventanas walk-forward
// ---------------------------------------------------------------------------

/** Tamaños de ventana en número de sesiones. */
export interface WalkForwardWindowOptions {
  /** Sesiones de entrenamiento por ventana (def. 126, ~6 meses de mercado). */
  trainSize?: number;
  /** Sesiones fuera de muestra por ventana (def. 63, ~3 meses). */
  testSize?: number;
  /** Paso entre ventanas en sesiones (def. `testSize`: pruebas no solapadas). */
  step?: number;
}

export const DEFAULT_WALK_FORWARD_TRAIN_SIZE = 126;
export const DEFAULT_WALK_FORWARD_TEST_SIZE = 63;

/** Una ventana rodante: se optimiza en `train` y se evalúa en `test`, siempre posterior. */
export interface WalkForwardWindow {
  index: number;
  train: SessionRange;
  test: SessionRange;
}

/**
 * Ventanas walk-forward rodantes sobre la línea temporal: `train` ocupa
 * `trainSize` sesiones y `test` las `testSize` siguientes (nunca se solapan:
 * `train.endDate < test.startDate`). La ventana se desplaza `step` sesiones
 * (def. `testSize`). La última ventana puede tener una prueba más corta si
 * solo queda ese resto; se descartan ventanas sin ninguna sesión de prueba.
 *
 * Devuelve [] si la línea temporal no alcanza para un solo ciclo
 * (`dates.length <= trainSize`).
 */
export function buildWalkForwardWindows(
  dates: readonly SessionDate[],
  options: WalkForwardWindowOptions = {},
): WalkForwardWindow[] {
  const ordered = normalizeDates(dates);
  const trainSize = options.trainSize ?? DEFAULT_WALK_FORWARD_TRAIN_SIZE;
  const testSize = options.testSize ?? DEFAULT_WALK_FORWARD_TEST_SIZE;
  const step = options.step ?? testSize;
  for (const [field, value] of [
    ['trainSize', trainSize],
    ['testSize', testSize],
    ['step', step],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`validación: '${field}' debe ser un entero >= 1 (${value})`);
    }
  }

  const windows: WalkForwardWindow[] = [];
  for (let start = 0; start + trainSize < ordered.length; start += step) {
    const trainEnd = start + trainSize;
    const testEnd = Math.min(trainEnd + testSize, ordered.length);
    windows.push({
      index: windows.length,
      train: { startDate: ordered[start]!, endDate: ordered[trainEnd - 1]! },
      test: { startDate: ordered[trainEnd]!, endDate: ordered[testEnd - 1]! },
    });
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Rejillas de parámetros
// ---------------------------------------------------------------------------

/**
 * Expande un rango {min, max, step} en la lista de valores, con redondeo
 * para compensar la aritmética binaria (0,1 + 0,1…). `max` se incluye si lo
 * alcanza un paso.
 */
export function expandRange(range: StrategyParameterRange): number[] {
  const { min, max, step } = range;
  for (const [field, value] of [
    ['min', min],
    ['max', max],
    ['step', step],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`validación: rango '${field}' no es un número finito (${value})`);
    }
  }
  if (step <= 0) {
    throw new RangeError(`validación: 'step' del rango debe ser > 0 (${step})`);
  }
  if (min > max) {
    throw new RangeError(`validación: rango invertido (min ${min} > max ${max})`);
  }
  const values: number[] = [];
  for (let i = 0; ; i++) {
    const value = min + i * step;
    if (value > max + step * 1e-9) break;
    values.push(Number(value.toPrecision(12)));
  }
  return values;
}

/**
 * Producto cartesiano de la rejilla sobre los parámetros base. Sin rejilla
 * devuelve solo los parámetros base. Lanza RangeError si la rejilla supera
 * `MAX_GRID_COMBINATIONS` celdas.
 */
export function expandParamGrid(
  base: StrategyParams,
  grid: Record<string, StrategyParameterRange>,
): StrategyParams[] {
  const names = Object.keys(grid).sort();
  const axis = names.map((name) => expandRange(grid[name]!));
  const total = axis.reduce((acc, values) => acc * values.length, 1);
  if (total > MAX_GRID_COMBINATIONS) {
    throw new RangeError(
      `validación: la rejilla tiene ${total} combinaciones (máximo ${MAX_GRID_COMBINATIONS})`,
    );
  }
  const combos: StrategyParams[] = [];
  const current: number[] = new Array(names.length).fill(0);
  for (let done = false; !done;) {
    const params: StrategyParams = { ...base };
    for (let k = 0; k < names.length; k++) params[names[k]!] = axis[k]![current[k]!]!;
    combos.push(params);
    for (let k = names.length - 1; ; k--) {
      if (k < 0) {
        done = true;
        break;
      }
      if (++current[k]! < axis[k]!.length) break;
      current[k] = 0;
    }
  }
  return combos;
}

// ---------------------------------------------------------------------------
// Walk-forward: optimizar en entrenamiento, evaluar fuera de muestra
// ---------------------------------------------------------------------------

/** Métrica objetivo para optimizar y para el mapa de sensibilidad. */
export type ObjectiveMetric = 'sharpe' | 'totalReturn' | 'profitFactor' | 'expectancy';

export const OBJECTIVE_METRICS: readonly ObjectiveMetric[] = [
  'sharpe',
  'totalReturn',
  'profitFactor',
  'expectancy',
];

/** Campos del `BacktestInput` que la validación reutiliza (estrategia, parámetros y rango los fija cada ejecución). */
type EngineSharedInput = Omit<BacktestInput, 'strategy' | 'params' | 'startDate' | 'endDate'>;

export interface WalkForwardInput extends EngineSharedInput {
  /** Factoría de la estrategia: cada backtest recibe una instancia nueva. */
  strategy: () => Strategy;
  /** Parámetros base (versión en evaluación); la rejilla los sobrescribe. */
  params?: StrategyParams;
  /** Parámetros a optimizar con su rango; vacío/omitido = solo los base. */
  grid?: Record<string, StrategyParameterRange>;
  /** Tamaños de ventana en sesiones (def. 126/63, paso = testSize). */
  window?: WalkForwardWindowOptions;
  /** Métrica a maximizar en la ventana de entrenamiento (def. 'sharpe'). */
  objective?: ObjectiveMetric;
  /** Línea temporal (def. unión de fechas de `bars`). */
  dates?: readonly SessionDate[];
}

/** Una ventana evaluada: parámetros elegidos en muestra y resultado fuera de muestra. */
export interface WalkForwardWindowResult {
  index: number;
  train: SessionRange;
  test: SessionRange;
  /** Parámetros ganadores en la ventana de entrenamiento. */
  params: StrategyParams;
  /** Valor de la métrica objetivo en entrenamiento (null si no está definida). */
  inSampleMetric: number | null;
  inSampleMetrics: BacktestMetrics;
  /** Valor de la métrica objetivo fuera de muestra (null si no está definida). */
  outOfSampleMetric: number | null;
  outOfSampleMetrics: BacktestMetrics;
  /** Backtest completo fuera de muestra (operaciones y curva). */
  outOfSampleResult: BacktestResult;
  /** Combinaciones de la rejilla evaluadas en esta ventana. */
  candidates: number;
}

export interface WalkForwardResult {
  objective: ObjectiveMetric;
  windows: WalkForwardWindowResult[];
  /**
   * Media de la métrica objetivo en entrenamiento y fuera de muestra,
   * sobre las ventanas donde está definida y es finita; null si ninguna.
   * Es el par de valores que alimenta la regla «Sharpe OOS < 50 % IS».
   */
  meanInSampleMetric: number | null;
  meanOutOfSampleMetric: number | null;
  /** Todas las operaciones fuera de muestra, concatenadas en orden de ventana. */
  outOfSampleTrades: MetricTrade[];
}

function metricValue(metrics: BacktestMetrics, objective: ObjectiveMetric): number | null {
  return metrics[objective];
}

function meanFinite(values: readonly (number | null)[]): number | null {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return finite.length === 0 ? null : finite.reduce((a, b) => a + b, 0) / finite.length;
}

/**
 * Ejecuta el walk-forward: por cada ventana evalúa la rejilla de parámetros
 * en el tramo de entrenamiento, elige la combinación con mejor métrica
 * objetivo (empate → la primera en orden de rejilla) y la evalúa en el
 * tramo fuera de muestra siguiente.
 *
 * Cada ejecución usa una instancia nueva de la estrategia (`strategy()`).
 * Las velas anteriores a cada tramo quedan disponibles como calentamiento,
 * igual que en una operativa real.
 */
export function runWalkForward(input: WalkForwardInput): WalkForwardResult {
  if (typeof input?.strategy !== 'function') {
    throw new TypeError(
      'validación: se espera una factoría de estrategia `strategy: () => Strategy`',
    );
  }
  const dates = input.dates ?? unionDates(input.bars);
  const windows = buildWalkForwardWindows(dates, input.window);
  const objective = input.objective ?? 'sharpe';
  const baseParams = input.params ?? {};
  const grid = input.grid ?? {};
  const candidates = expandParamGrid(baseParams, grid);

  const shared: EngineSharedInput = {
    bars: input.bars,
    universe: input.universe,
    initialCash: input.initialCash,
    costs: input.costs,
    riskPerTrade: input.riskPerTrade,
    maxPositions: input.maxPositions,
  };

  const results: WalkForwardWindowResult[] = windows.map((window) => {
    let bestParams: StrategyParams = candidates[0]!;
    let bestValue = Number.NEGATIVE_INFINITY;
    let bestMetrics: BacktestMetrics | null = null;
    for (const params of candidates) {
      const result = runBacktest({
        ...shared,
        strategy: input.strategy(),
        params,
        startDate: window.train.startDate,
        endDate: window.train.endDate,
      });
      const metrics = computeMetrics(result.equityCurve, result.trades);
      const value = metricValue(metrics, objective) ?? Number.NEGATIVE_INFINITY;
      if (bestMetrics === null || value > bestValue) {
        bestValue = value;
        bestParams = params;
        bestMetrics = metrics;
      }
    }

    const testResult = runBacktest({
      ...shared,
      strategy: input.strategy(),
      params: bestParams,
      startDate: window.test.startDate,
      endDate: window.test.endDate,
    });
    const testMetrics = computeMetrics(testResult.equityCurve, testResult.trades);

    return {
      index: window.index,
      train: window.train,
      test: window.test,
      params: bestParams,
      inSampleMetric: bestValue === Number.NEGATIVE_INFINITY ? null : bestValue,
      inSampleMetrics: bestMetrics!,
      outOfSampleMetric: metricValue(testMetrics, objective),
      outOfSampleMetrics: testMetrics,
      outOfSampleResult: testResult,
      candidates: candidates.length,
    };
  });

  return {
    objective,
    windows: results,
    meanInSampleMetric: meanFinite(results.map((w) => w.inSampleMetric)),
    meanOutOfSampleMetric: meanFinite(results.map((w) => w.outOfSampleMetric)),
    outOfSampleTrades: results.flatMap((w) => w.outOfSampleResult.trades),
  };
}

// ---------------------------------------------------------------------------
// Mapa de sensibilidad
// ---------------------------------------------------------------------------

/** Un eje del mapa de sensibilidad: parámetro y rango a barrer. */
export interface SensitivityAxis {
  param: string;
  range: StrategyParameterRange;
}

export interface SensitivityInput extends EngineSharedInput {
  strategy: () => Strategy;
  params?: StrategyParams;
  x: SensitivityAxis;
  y: SensitivityAxis;
  /** Métrica por celda (def. 'sharpe'). */
  metric?: ObjectiveMetric;
  /** Restringe el backtest a este periodo (p. ej. solo el tramo de entrenamiento). */
  startDate?: SessionDate;
  endDate?: SessionDate;
}

/**
 * Rejilla 2D de sensibilidad: `cells[y][x]` es la métrica del backtest con
 * `x = xValues[x]` e `y = yValues[y]`; null si no está definida (p. ej.
 * Sharpe sin operaciones). `baseCell` apunta a la celda más cercana a los
 * parámetros de la versión (distancia por eje; empate → índice menor).
 */
export interface SensitivityMap {
  metric: ObjectiveMetric;
  xParam: string;
  xValues: number[];
  yParam: string;
  yValues: number[];
  cells: (number | null)[][];
  baseCell: { x: number; y: number };
  /** Métrica en la celda base; null si no está definida. */
  baseValue: number | null;
}

function nearestIndex(values: readonly number[], target: number | undefined): number {
  if (target === undefined || !Number.isFinite(target)) {
    return Math.floor(values.length / 2);
  }
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i]! - target) < Math.abs(values[best]! - target)) best = i;
  }
  return best;
}

/**
 * Mapa de sensibilidad de dos parámetros: un backtest por celda de la
 * rejilla x × y con el resto de parámetros fijos en `params`. Conviene
 * ejecutarlo sobre el tramo de entrenamiento (`startDate`/`endDate`) para
 * no consumir información fuera de muestra.
 */
export function runSensitivityMap(input: SensitivityInput): SensitivityMap {
  if (typeof input?.strategy !== 'function') {
    throw new TypeError(
      'validación: se espera una factoría de estrategia `strategy: () => Strategy`',
    );
  }
  if (input.x.param === input.y.param) {
    throw new RangeError(`validación: los ejes del mapa repiten el parámetro '${input.x.param}'`);
  }
  const metric = input.metric ?? 'sharpe';
  const xValues = expandRange(input.x.range);
  const yValues = expandRange(input.y.range);
  if (xValues.length * yValues.length > MAX_GRID_COMBINATIONS) {
    throw new RangeError(
      `validación: el mapa de sensibilidad tiene ${xValues.length * yValues.length} celdas (máximo ${MAX_GRID_COMBINATIONS})`,
    );
  }

  const cells: (number | null)[][] = yValues.map((y) =>
    xValues.map((x) => {
      const result = runBacktest({
        bars: input.bars,
        universe: input.universe,
        initialCash: input.initialCash,
        costs: input.costs,
        riskPerTrade: input.riskPerTrade,
        maxPositions: input.maxPositions,
        strategy: input.strategy(),
        params: { ...input.params, [input.x.param]: x, [input.y.param]: y },
        startDate: input.startDate,
        endDate: input.endDate,
      });
      return metricValue(computeMetrics(result.equityCurve, result.trades), metric);
    }),
  );

  const baseCell = {
    x: nearestIndex(xValues, input.params?.[input.x.param]),
    y: nearestIndex(yValues, input.params?.[input.y.param]),
  };
  return {
    metric,
    xParam: input.x.param,
    xValues,
    yParam: input.y.param,
    yValues,
    cells,
    baseCell,
    baseValue: cells[baseCell.y]![baseCell.x]!,
  };
}

// ---------------------------------------------------------------------------
// Monte Carlo sobre el orden de las operaciones
// ---------------------------------------------------------------------------

/**
 * - `permutation`: baraja el orden de las operaciones. Conserva el
 *   conjunto completo en cada simulación, así que la suma de PnL (y la
 *   rentabilidad final) es siempre la observada; la dispersión aparece en
 *   el drawdown y la forma de la curva.
 * - `bootstrap`: remuestrea `n` operaciones con reemplazo. La suma de PnL
 *   varía entre simulaciones; sirve para dispersar también la rentabilidad.
 */
export type MonteCarloMethod = 'permutation' | 'bootstrap';

export interface MonteCarloInput {
  /** Operaciones del backtest (solo se usa `pnl`). */
  trades: readonly Pick<MetricTrade, 'pnl'>[];
  /** Capital inicial para convertir PnL en curva (def. 10 000). */
  initialCash?: number;
  /** Número de simulaciones (def. 1 000, máx. 100 000). */
  simulations?: number;
  /** Semilla del generador; la misma semilla reproduce la distribución exacta. */
  seed?: number;
  method?: MonteCarloMethod;
}

export interface MonteCarloPercentiles {
  p5: number;
  p50: number;
  p95: number;
}

/** Una simulación: rentabilidad total y drawdown máximo (en tanto por uno, positivo). */
export interface MonteCarloSample {
  totalReturn: number;
  maxDrawdown: number;
}

export interface MonteCarloResult {
  method: MonteCarloMethod;
  seed: number;
  simulations: number;
  /** Operaciones por simulación (= `trades.length`). */
  tradeCount: number;
  initialCash: number;
  /** Percentiles de la rentabilidad total simulada (tanto por uno). */
  returnPercentiles: MonteCarloPercentiles;
  /** Percentiles del drawdown máximo simulado (tanto por uno, positivo). */
  drawdownPercentiles: MonteCarloPercentiles;
  /** Una entrada por simulación, en orden de ejecución: para el histograma. */
  distribution: MonteCarloSample[];
}

/** PRNG determinista (mulberry32): suficiente para barajar y remuestrear. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentil con interpolación lineal (definición 7, como numpy/R). */
function percentile(sorted: readonly number[], p: number): number {
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (index - lo);
}

/**
 * Simulación Monte Carlo del orden de las operaciones. Determinista: la
 * misma semilla, método y conjunto de operaciones producen exactamente el
 * mismo resultado, sea cual sea el orden de entrada de las operaciones.
 */
export function runMonteCarlo(input: MonteCarloInput): MonteCarloResult {
  if (input === null || typeof input !== 'object' || !Array.isArray(input.trades)) {
    throw new TypeError('validación: Monte Carlo espera { trades: [{ pnl }] }');
  }
  const simulations = input.simulations ?? DEFAULT_MONTE_CARLO_SIMULATIONS;
  if (
    !Number.isInteger(simulations) ||
    simulations < 1 ||
    simulations > MAX_MONTE_CARLO_SIMULATIONS
  ) {
    throw new RangeError(
      `validación: 'simulations' debe ser un entero entre 1 y ${MAX_MONTE_CARLO_SIMULATIONS} (${simulations})`,
    );
  }
  const seed = input.seed ?? DEFAULT_MONTE_CARLO_SEED;
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new TypeError(`validación: 'seed' debe ser un número finito (${String(seed)})`);
  }
  const initialCash = input.initialCash ?? 10_000;
  if (!Number.isFinite(initialCash) || initialCash <= 0) {
    throw new RangeError(`validación: 'initialCash' debe ser > 0 (${initialCash})`);
  }
  const method = input.method ?? 'permutation';
  if (method !== 'permutation' && method !== 'bootstrap') {
    throw new RangeError(`validación: método Monte Carlo desconocido (${String(input.method)})`);
  }
  for (const [index, trade] of input.trades.entries()) {
    if (typeof trade?.pnl !== 'number' || !Number.isFinite(trade.pnl)) {
      throw new TypeError(`validación: pnl de la operación ${index} no es finito (${trade?.pnl})`);
    }
  }

  // Orden canónico por PnL: el resultado no depende del orden de entrada.
  const pnls = input.trades.map((t) => t.pnl).sort((a, b) => a - b);
  const n = pnls.length;
  const random = mulberry32(seed);

  const distribution: MonteCarloSample[] = [];
  for (let s = 0; s < simulations; s++) {
    const order = new Array<number>(n);
    if (method === 'permutation') {
      for (let i = 0; i < n; i++) order[i] = i;
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
    } else {
      for (let i = 0; i < n; i++) order[i] = Math.floor(random() * n);
    }

    let equity = initialCash;
    let peak = initialCash;
    let maxDrawdown = 0;
    for (const idx of order) {
      equity += pnls[idx]!;
      if (equity > peak) peak = equity;
      // Con un máximo no positivo toda caída es ruina (100 %).
      const drawdown = peak > 0 ? (peak - equity) / peak : 1;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
    distribution.push({ totalReturn: equity / initialCash - 1, maxDrawdown });
  }

  const returns = distribution.map((d) => d.totalReturn).sort((a, b) => a - b);
  const drawdowns = distribution.map((d) => d.maxDrawdown).sort((a, b) => a - b);
  return {
    method,
    seed,
    simulations,
    tradeCount: n,
    initialCash,
    returnPercentiles: {
      p5: percentile(returns, 0.05),
      p50: percentile(returns, 0.5),
      p95: percentile(returns, 0.95),
    },
    drawdownPercentiles: {
      p5: percentile(drawdowns, 0.05),
      p50: percentile(drawdowns, 0.5),
      p95: percentile(drawdowns, 0.95),
    },
    distribution,
  };
}

// ---------------------------------------------------------------------------
// Avisos de sobreajuste
// ---------------------------------------------------------------------------

export const OVERFIT_RULES = [
  'oos-sharpe-decay',
  'sensitivity-collapse',
  'monte-carlo-tail',
] as const;
export type OverfitRule = (typeof OVERFIT_RULES)[number];

/** Aviso de sobreajuste con la regla que lo produjo y su explicación. */
export interface OverfitWarning {
  rule: OverfitRule;
  /** Texto del aviso para el informe, con el criterio concreto y las cifras. */
  message: string;
}

/** Entradas de `evaluateOverfitting`; una regla sin datos no se evalúa (no avisa). */
export interface OverfitInput {
  /** Sharpe en la muestra de entrenamiento (o media walk-forward en muestra). */
  inSampleSharpe?: number | null;
  /** Sharpe fuera de muestra (validación, media walk-forward o prueba). */
  outOfSampleSharpe?: number | null;
  /** Mapa de sensibilidad sobre el tramo de entrenamiento. */
  sensitivity?: SensitivityMap | null;
  /** Resultado Monte Carlo de las operaciones del backtest. */
  monteCarlo?: MonteCarloResult | null;
}

const fmtNumber = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : v > 0 ? '∞' : '-∞');
const fmtPct = (v: number): string => `${(v * 100).toFixed(1)} %`;

/**
 * Reglas de aviso de sobreajuste del plan; cada aviso explica el criterio:
 *
 * 1. `oos-sharpe-decay`: el Sharpe fuera de muestra es menor que el 50 %
 *    del de entrenamiento (ambos definidos y el de entrenamiento finito).
 * 2. `sensitivity-collapse`: más de la mitad de las celdas vecinas (a un
 *    paso del punto elegido en la rejilla 2D) caen por debajo del 50 % del
 *    valor de la celda base. Solo se evalúa con base positiva y al menos
 *    un vecino definido.
 * 3. `monte-carlo-tail`: el percentil 5 tiene rentabilidad negativa y
 *    drawdown superior al 10 %.
 */
export function evaluateOverfitting(input: OverfitInput): OverfitWarning[] {
  const warnings: OverfitWarning[] = [];
  const isSharpe = input.inSampleSharpe;
  const oosSharpe = input.outOfSampleSharpe;

  if (
    isSharpe !== null &&
    isSharpe !== undefined &&
    Number.isFinite(isSharpe) &&
    oosSharpe !== null &&
    oosSharpe !== undefined &&
    oosSharpe < SHARPE_DECAY_RATIO * isSharpe
  ) {
    warnings.push({
      rule: 'oos-sharpe-decay',
      message:
        `Posible sobreajuste: el Sharpe fuera de muestra (${fmtNumber(oosSharpe)}) es ` +
        `inferior al 50 % del de entrenamiento (${fmtNumber(isSharpe)}).`,
    });
  }

  const map = input.sensitivity;
  if (map !== null && map !== undefined) {
    const base = map.baseValue;
    if (base !== null && base > 0) {
      const { x: bx, y: by } = map.baseCell;
      const neighbors: number[] = [];
      for (let y = Math.max(0, by - 1); y <= Math.min(map.yValues.length - 1, by + 1); y++) {
        for (let x = Math.max(0, bx - 1); x <= Math.min(map.xValues.length - 1, bx + 1); x++) {
          if (x === bx && y === by) continue;
          const value = map.cells[y]![x]!;
          if (value !== null && Number.isFinite(value)) neighbors.push(value);
        }
      }
      if (neighbors.length > 0) {
        const collapsed = neighbors.filter((v) => v < SENSITIVITY_COLLAPSE_RATIO * base).length;
        if (collapsed > neighbors.length / 2) {
          warnings.push({
            rule: 'sensitivity-collapse',
            message:
              `Posible sobreajuste: ${collapsed} de ${neighbors.length} vecinos del punto ` +
              `elegido en el mapa de sensibilidad pierden más del 50 % del resultado ` +
              `(${fmtNumber(base)}); el rendimiento depende de un ajuste muy fino de los ` +
              `parámetros.`,
          });
        }
      }
    }
  }

  const mc = input.monteCarlo;
  if (mc !== null && mc !== undefined) {
    const p5Return = mc.returnPercentiles.p5;
    const p5Drawdown = mc.drawdownPercentiles.p5;
    if (p5Return < 0 && p5Drawdown > MONTE_CARLO_TAIL_DRAWDOWN) {
      warnings.push({
        rule: 'monte-carlo-tail',
        message:
          `Posible sobreajuste: en el 5 % peor de las simulaciones Monte Carlo la ` +
          `rentabilidad es negativa (${fmtPct(p5Return)}) con un drawdown del ` +
          `${fmtPct(p5Drawdown)}, por encima del 10 %.`,
      });
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Prueba final bloqueada
// ---------------------------------------------------------------------------

/**
 * La prueba final ya se ejecutó para esta versión de la estrategia: el
 * servicio persiste la bandera y vuelve a lanzar este error si se reintenta.
 * Repetirla exige crear una versión nueva.
 */
export class FinalTestLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinalTestLockedError';
  }
}

/** Estado de la prueba final para el informe (lo mapea la interfaz). */
export type FinalTestStatus = 'disponible' | 'ejecutada';

export function finalTestStatus(executed: boolean): FinalTestStatus {
  return executed ? 'ejecutada' : 'disponible';
}

export interface FinalTestInput extends BacktestInput {
  /**
   * Bandera persistida por el servicio: true si esta versión ya consumió su
   * prueba final. En ese caso `runFinalTest` lanza `FinalTestLockedError`.
   */
  alreadyExecuted?: boolean;
}

export interface FinalTestResult {
  result: BacktestResult;
  metrics: BacktestMetrics;
  /**
   * Bandera que el servicio debe persistir tras esta llamada: siempre
   * `true`. Una vez guardada, la versión no puede volver a ejecutarla.
   */
  executed: true;
}

/**
 * Ejecuta el backtest sobre el tramo de prueba bloqueado. Se puede llamar
 * una sola vez por versión: con `alreadyExecuted` lanza
 * `FinalTestLockedError`. Devuelve las métricas junto al resultado para que
 * el informe las guarde tal cual.
 */
export function runFinalTest(input: FinalTestInput): FinalTestResult {
  if (input.alreadyExecuted === true) {
    throw new FinalTestLockedError(
      'validación: la prueba final ya se ejecutó para esta versión; ' +
        'repetirla exige crear una versión nueva de la estrategia',
    );
  }
  const result = runBacktest(input);
  return {
    result,
    metrics: computeMetrics(result.equityCurve, result.trades),
    executed: true,
  };
}
